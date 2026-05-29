// Vercel Cron Job - runs daily at 09:00 KST (00:00 UTC)
// Detects delays and sends alerts via Supabase

const SUPABASE_URL = 'https://cqvtqcnjmmfvvynsgmei.supabase.co';
const SUPABASE_KEY = 'sb_publishable_pCAcvd2jsuIx_1hcksk9NQ_UVlUqK8S';

const DELAY_RULES = {
  no_action:  { days: 7,  label: 'No Action',         stage: 'No movement on PI (no PO/HQPO/Shipment)' },
  hqpo_delay: { days: 30, label: 'Awaiting Shipment',  stage: 'PI has activity but no Shipment yet' },
  col_delay:  { days: 30, label: 'Collection Pending', stage: 'Shipped but not yet collected' },
};

async function query(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || '',
    },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${path}: ${res.status} ${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

export default async function handler(req, res) {
  // Security: only allow Vercel cron calls
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[CRON] Starting daily delay check:', new Date().toISOString());

    // Fetch all pipeline data in parallel
    const [piRows, poRows, hqRows, shRows, colRows, existNotifs] = await Promise.all([
      query('pi?select=pi_number,date,distributor,sales_rep,status&status=neq.Cancelled'),
      query('po?select=pi_number,date'),
      query('hq_po?select=pi_number,date'),
      query('shipments?select=pi_number,date'),
      query('collections?select=pi_number,status'),
      query('notifications?select=related_id,created_at,read_by&type=eq.alert'),
    ]);

    const poSet  = new Set(poRows.map(r => r.pi_number));
    const hqSet  = new Set(hqRows.map(r => r.pi_number));
    const shSet  = new Set(shRows.filter(r => r.date).map(r => r.pi_number));
    const colOk  = new Set(colRows.filter(r => r.status === 'Collected').map(r => r.pi_number));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayDiff = (d) => Math.floor((today - new Date(d)) / 86400000);

    // Map existing alerts: related_id → array of {sentAt, isRead}
    const sentMap = {};
    existNotifs.forEach(n => {
      if (!n.related_id) return;
      if (!sentMap[n.related_id]) sentMap[n.related_id] = [];
      sentMap[n.related_id].push({
        at: new Date(n.created_at),
        read: Array.isArray(n.read_by) && n.read_by.length > 0,
      });
    });

    const toInsert = [];
    const toUpdate = []; // related_ids to re-alert (escalation)

    for (const p of piRows) {
      if (!p.date) continue;
      const num = p.pi_number;
      const rep = p.sales_rep || null;
      const dist = p.distributor || '';
      const dPI = dayDiff(p.date);
      const hasAny = poSet.has(num) || hqSet.has(num) || shSet.has(num);

      let stage = null, stageDays = 0;
      if (!hasAny) {
        if (dPI >= DELAY_RULES.no_action.days) { stage = 'no_action'; stageDays = dPI; }
      } else if (hasAny && !shSet.has(num)) {
        if (dPI >= DELAY_RULES.hqpo_delay.days) { stage = 'hqpo_delay'; stageDays = dPI; }
      } else if (shSet.has(num) && !colOk.has(num)) {
        const sr = shRows.find(r => r.pi_number === num && r.date);
        if (sr) {
          const d = dayDiff(sr.date);
          if (d >= DELAY_RULES.col_delay.days) { stage = 'col_delay'; stageDays = d; }
        }
      }
      if (!stage) continue;

      const key = `${num}_${stage}`;
      const rule = DELAY_RULES[stage];
      const prev = sentMap[key] || [];

      if (prev.length === 0) {
        // First alert
        toInsert.push({
          type: 'alert',
          title: `⚠️ ${rule.label} — ${num}`,
          message: `Distributor: ${dist}\nStage: ${rule.stage}\nDelayed: ${stageDays} days\n\n⚠️ Please reply with reason and action plan within 24 hours.`,
          from_user: 'system',
          to_user: rep,
          related_page: 'pi',
          related_id: key,
        });
      } else {
        // Check if last alert was >24h ago and no response
        const last = prev[prev.length - 1];
        const hoursSince = (Date.now() - last.at) / 3600000;
        const hasResponse = prev.some(n => n.read);
        if (hoursSince >= 24 && !hasResponse) {
          // Escalation: update existing alert + notify admin
          toUpdate.push({ key, num, rep, dist, stageDays, rule });
        }
      }
    }

    // Insert new alerts
    let inserted = 0, escalated = 0;
    if (toInsert.length) {
      await query('notifications', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify(toInsert),
      });
      inserted = toInsert.length;
    }

    // Process escalations
    for (const { key, num, rep, dist, stageDays, rule } of toUpdate) {
      // Update existing notification (mark unread, update message)
      await query(`notifications?related_id=eq.${key}&type=eq.alert`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          message: `Distributor: ${dist}\nStage: ${rule.stage}\nDelayed: ${stageDays} days\n\n🔴 ESCALATION: No response received in 24 hours. Immediate action required.`,
          read_by: [],
        }),
      });
      // Notify admin
      await query('notifications', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify([{
          type: 'alert',
          title: `🔴 Admin Alert: No response — ${num}`,
          message: `Sales Rep @${rep || 'unknown'} has not responded to delay alert for ${num} (${stageDays}d delayed).\n\nDeal: ${dist}`,
          from_user: 'system',
          to_user: null, // all admins see it
          related_page: 'pi',
          related_id: `${key}_esc`,
        }]),
      });
      escalated++;
    }

    const summary = `Inserted: ${inserted}, Escalated: ${escalated}`;
    console.log('[CRON] Done:', summary);
    return res.status(200).json({ ok: true, summary, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[CRON] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
