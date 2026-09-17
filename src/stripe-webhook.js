import { db, now } from './db/index.js';
import config, { canBill } from './config.js';
import { stripe, move, account } from './billing.js';
import { addActivity } from './traffic.js';

/* Credits are written here and nowhere else, keyed on the Stripe object under a unique
   index, so a retried event cannot credit the same money twice. */

export async function handleWebhook(req, res) {
  if (!canBill() || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).send('billing not configured');
  const s = await stripe();
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`signature: ${err.message}`);
  }
  if (db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id)) return res.json({ ok: true, dedup: true });
  db.prepare('INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)')
    .run(event.id, event.type, now());

  const o = event.data.object;
  const wsId = o?.metadata?.workspace_id
    || db.prepare('SELECT workspace_id FROM billing_accounts WHERE stripe_customer = ?')
         .get(o?.customer ?? '')?.workspace_id;

  try {
    if (event.type === 'checkout.session.completed' && wsId) {
      if (o.mode === 'payment') {
        const pi = await s.paymentIntents.retrieve(o.payment_intent);
        if (pi.payment_method) await saveCard(wsId, s, pi.payment_method, o.customer);
        credit(wsId, (o.amount_total ?? 0) / 100, pi.id, 'Card top up');
      } else if (o.mode === 'subscription') {
        db.prepare(`UPDATE billing_accounts SET plan = ?, plan_status = 'active', updated_at = ?
                     WHERE workspace_id = ?`).run(o.subscription, now(), wsId);
        db.prepare(`UPDATE workspaces SET mode = 'observe' WHERE id = ?`).run(wsId);
        addActivity(wsId, { kind: 'bill', title: 'Monthly plan started', detail: 'Measurement runs on your allowance.' });
      }
    } else if (event.type === 'payment_intent.succeeded' && wsId && o.metadata?.topup === '1') {
      credit(wsId, (o.amount_received ?? o.amount ?? 0) / 100, o.id, 'Automatic top up');
    } else if (event.type === 'payment_intent.payment_failed' && wsId) {
      const code = o.last_payment_error?.decline_code || o.last_payment_error?.code || 'declined';
      db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                   WHERE workspace_id = ?`).run(code, now(), wsId);
      addActivity(wsId, {
        kind: 'bill', title: 'A top up was declined',
        detail: 'Automatic top up is off until a card is added. Update it in Settings and calls resume.',
      });
    } else if (event.type === 'customer.subscription.deleted' && wsId) {
      db.prepare(`UPDATE billing_accounts SET plan_status = 'cancelled', updated_at = ? WHERE workspace_id = ?`)
        .run(now(), wsId);
      db.prepare(`UPDATE workspaces SET mode = 'route' WHERE id = ?`).run(wsId);
      addActivity(wsId, { kind: 'bill', title: 'Monthly plan cancelled', detail: 'Measurement draws on your balance now.' });
    }
  } catch (err) {
    return res.status(500).send(String(err.message).slice(0, 200));
  }
  return res.json({ ok: true });
}

function credit(workspaceId, amountUsd, ref, note) {
  if (!(amountUsd > 0)) return;
  const r = move(workspaceId, { kind: 'credit', amountUsd, note, ref });
  if (!r.duplicate) {
    db.prepare('UPDATE billing_accounts SET auto_topup = 1, topup_failed_note = NULL WHERE workspace_id = ?')
      .run(workspaceId);
    addActivity(workspaceId, {
      kind: 'bill', title: `Added $${amountUsd.toFixed(2)} of credit`, detail: note,
    });
  }
}

async function saveCard(workspaceId, s, paymentMethodId, customerId) {
  const pm = await s.paymentMethods.retrieve(paymentMethodId);
  db.prepare(`UPDATE billing_accounts SET payment_method = ?, stripe_customer = COALESCE(stripe_customer, ?),
              card_brand = ?, card_last4 = ?, updated_at = ? WHERE workspace_id = ?`)
    .run(paymentMethodId, customerId ?? null, pm.card?.brand ?? null, pm.card?.last4 ?? null, now(), workspaceId);
  account(workspaceId);
}
