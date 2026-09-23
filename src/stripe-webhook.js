import { db, now } from './db/index.js';
import config from './config.js';
import { stripe, move, account } from './billing.js';
import { addActivity } from './traffic.js';

/* Credits are written here and nowhere else, keyed on the Stripe object under a unique
   index, so a retried event cannot credit the same money twice.

   Four rules decide what becomes balance:
   - Only money that has actually arrived. A Checkout can complete with a payment still on its way
     (a bank debit, for example) and "completed" is not "paid": it is credited when Stripe says the
     payment succeeded, and never if it fails.
   - Money that goes back comes off again: a refund or a dispute takes its amount off the balance,
     once, however many times Stripe tells us.
   - A test payment never becomes balance on a public deployment. A test key takes Stripe's public
     practice card, and the balance buys real model calls.
   - Adding credit never switches automatic top up on by itself. It charges a card when nobody is
     there, so it is on only when the customer asked for it. */

export async function handleWebhook(req, res) {
  const s = await stripe();
  if (!s || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).send('billing not configured');
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`signature: ${err.message}`);
  }
  /* Seen is not the same as done. Recording the id up front and answering 500 on a failure
     meant Stripe's retry was thrown away as a duplicate, so one transient blip lost the
     payment for good. The row is claimed now and stamped handled only once the work below
     has succeeded, which is what makes a retry useful rather than wasted. */
  const seen = await db.prepare('SELECT handled_at FROM stripe_events WHERE id = ?').get(event.id);
  if (seen?.handled_at != null) return res.json({ ok: true, dedup: true });
  if (!seen) {
    await db.prepare('INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .run(event.id, event.type, now());
  }
  const handled = async (extra = {}) => {
    await db.prepare('UPDATE stripe_events SET handled_at = ? WHERE id = ?').run(now(), event.id);
    return res.json({ ok: true, ...extra });
  };

  // answered 200 so Stripe stops retrying, and nothing else happens
  if (event.livemode === false && !config.ALLOW_TEST_PAYMENTS) {
    return handled({ ignored: 'test payments do not become balance on this deployment' });
  }

  const o = event.data.object;
  try {
    const wsId = await workspaceOf(s, o);
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (!wsId) break;
        if (o.mode === 'payment') {
          // "completed" with the money still on its way is credited when it arrives, by the event after
          if (o.payment_status !== 'paid') break;
          const pi = await s.paymentIntents.retrieve(o.payment_intent);
          if (pi.payment_method) await saveCard(wsId, s, pi.payment_method, o.customer);
          await credit(wsId, (o.amount_total ?? 0) / 100, pi.id, 'Card top up');
          if (o.metadata?.auto_topup === '1' && pi.payment_method) {
            await db.prepare('UPDATE billing_accounts SET auto_topup = 1, topup_failed_note = NULL WHERE workspace_id = ?').run(wsId);
          }
        } else if (o.mode === 'subscription') {
          await db.prepare(`UPDATE billing_accounts SET plan = ?, plan_status = 'active', allowance_period_start = ?,
                              eval_used_usd = 0, updated_at = ? WHERE workspace_id = ?`)
            .run(o.subscription, now(), now(), wsId);
          await addActivity(wsId, {
            kind: 'bill', title: 'Monthly plan started',
            detail: `Measuring draws on the plan's $${config.EVAL_ALLOWANCE_USD.toFixed(2)} a month first, then on your balance.`,
          });
        }
        break;
      case 'checkout.session.async_payment_failed':
        if (wsId) {
          await addActivity(wsId, {
            kind: 'bill', title: 'A payment did not go through',
            detail: 'Your bank did not complete the payment, so no credit was added. Nothing was charged.',
          });
        }
        break;
      case 'payment_intent.succeeded':
        if (wsId && o.metadata?.topup === '1') {
          await credit(wsId, (o.amount_received ?? o.amount ?? 0) / 100, o.id, 'Automatic top up');
        }
        break;
      case 'payment_intent.payment_failed':
        if (wsId && o.metadata?.topup === '1') {
          const code = o.last_payment_error?.decline_code || o.last_payment_error?.code || 'declined';
          await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                       WHERE workspace_id = ?`).run(code, now(), wsId);
          await addActivity(wsId, {
            kind: 'bill', title: 'A top up was declined',
            detail: 'Automatic top up is off until a card is added. Update it in Settings and calls resume.',
          });
        }
        break;
      case 'charge.refunded':
        if (wsId) await takeBack(wsId, o.id, (o.amount_refunded ?? 0) / 100, 'refund', 'Refunded to your card');
        break;
      case 'charge.dispute.created':
        if (wsId) {
          await takeBack(wsId, o.id, (o.amount ?? 0) / 100, 'dispute', 'Disputed with your bank');
          await db.prepare('UPDATE billing_accounts SET auto_topup = 0, updated_at = ? WHERE workspace_id = ?').run(now(), wsId);
        }
        break;
      case 'customer.subscription.deleted':
        if (wsId) {
          await db.prepare(`UPDATE billing_accounts SET plan_status = 'cancelled', updated_at = ? WHERE workspace_id = ?`)
            .run(now(), wsId);
          await addActivity(wsId, { kind: 'bill', title: 'Monthly plan cancelled', detail: 'Measuring draws on your balance now.' });
        }
        break;
      default:
        break;
    }
  } catch (err) {
    /* Left unstamped on purpose, so Stripe's retry runs it again. Money cannot be written
       twice by that retry: every credit carries the Stripe object id as its ledger ref under
       a unique index, so a second run of the same event is a no-op rather than a duplicate. */
    console.error(`stripe ${event.type} ${event.id} failed: ${err.message}`);
    return res.status(500).send(String(err.message).slice(0, 200));
  }
  return handled();
}

/* Which workspace an object belongs to: its own metadata, the customer it names, or, for a
   dispute, the charge it disputes. */
async function workspaceOf(s, o) {
  if (o?.metadata?.workspace_id) return o.metadata.workspace_id;
  let customer = o?.customer ?? null;
  if (!customer && o?.object === 'dispute' && o.charge) {
    const ch = typeof o.charge === 'string' ? await s.charges.retrieve(o.charge) : o.charge;
    if (ch?.metadata?.workspace_id) return ch.metadata.workspace_id;
    customer = ch?.customer ?? null;
  }
  if (!customer) return null;
  return (await db.prepare('SELECT workspace_id FROM billing_accounts WHERE stripe_customer = ?').get(customer))?.workspace_id ?? null;
}

async function credit(workspaceId, amountUsd, ref, note) {
  if (!(amountUsd > 0)) return;
  const r = await move(workspaceId, { kind: 'credit', amountUsd, note, ref });
  if (!r.duplicate) {
    await db.prepare('UPDATE billing_accounts SET topup_failed_note = NULL WHERE workspace_id = ?').run(workspaceId);
    await addActivity(workspaceId, {
      kind: 'bill', title: `Added $${amountUsd.toFixed(2)} of credit`, detail: note,
    });
  }
}

/* Money that went back to the card comes off the balance. A charge can be refunded in parts, and
   Stripe reports the running total each time, so what is taken is the total less what was already
   taken for that charge; each running total is its own ledger reference, so a repeat changes nothing. */
async function takeBack(workspaceId, sourceId, totalUsd, kind, note) {
  if (!(totalUsd > 0)) return;
  const prefix = `${kind}:${sourceId}`;
  const taken = Number((await db.prepare(
    `SELECT COALESCE(SUM(-amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND ref LIKE ?`)
    .get(workspaceId, `${prefix}:%`))?.s ?? 0);
  const more = Math.round((totalUsd - taken) * 100) / 100;
  if (!(more > 0)) return;
  const r = await move(workspaceId, {
    kind, amountUsd: -more, note, ref: `${prefix}:${Math.round(totalUsd * 100)}`,
  });
  if (!r.duplicate) {
    await addActivity(workspaceId, {
      kind: 'bill', title: `$${more.toFixed(2)} came off your balance`,
      detail: kind === 'dispute'
        ? 'A payment was disputed with your bank, so its credit was taken back and automatic top up is off.'
        : 'A payment was refunded to your card, so its credit was taken back.',
    });
  }
}

async function saveCard(workspaceId, s, paymentMethodId, customerId) {
  const pm = await s.paymentMethods.retrieve(paymentMethodId);
  await db.prepare(`UPDATE billing_accounts SET payment_method = ?, stripe_customer = COALESCE(stripe_customer, ?),
              card_brand = ?, card_last4 = ?, updated_at = ? WHERE workspace_id = ?`)
    .run(paymentMethodId, customerId ?? null, pm.card?.brand ?? null, pm.card?.last4 ?? null, now(), workspaceId);
  await account(workspaceId);
}
