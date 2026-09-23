import { notify } from './notify.js';
import { db, now } from './db/index.js';
import config from './config.js';
import { stripe, move, account, stripeErrorKind } from './billing.js';
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
          /* A card is kept for automatic top ups only from a checkout that set it up for them, where
             the customer ticked the box and was shown what it means. Every checkout used to replace
             the saved card, so a one-off payment with another card left automatic top up pointing
             at a card Stripe had never been told could be charged later, and the next top up failed. */
          const forTopUps = o.metadata?.auto_topup === '1' && !!pi.payment_method;
          if (forTopUps) await saveCard(wsId, s, pi.payment_method, o.customer);
          await credit(wsId, (o.amount_total ?? 0) / 100, pi.id, 'Card top up');
          if (forTopUps) {
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
          /* A decline Stripe says to try again (the issuer out of reach, try again later) is the top up
             job's to retry, as it does; switched off here, the retry found no card to charge. */
          const kind = stripeErrorKind({ type: 'StripeCardError', code: o.last_payment_error?.code,
            raw: { decline_code: o.last_payment_error?.decline_code } });
          if (kind === 'retry') break;
          /* Switched off here only if it was still on: when the top up job already heard the refusal, it
             has switched it off and told the owner, and saying it again is a second email about one card. */
          const wasOn = (await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                       WHERE workspace_id = ? AND auto_topup = 1 RETURNING workspace_id`).run(code, now(), wsId)).rows.length > 0;
          if (!wasOn) break;
          const confirm = code === 'authentication_required';
          await addActivity(wsId, {
            kind: 'bill', title: confirm ? 'A top up needs your confirmation' : 'A top up was declined',
            detail: confirm
              ? 'Your bank asked for you to confirm this one in person. Adding credit again takes care of it, and calls resume.'
              : 'Automatic top up is off until a card is added. Update it in Settings and calls resume.',
          });
          // a card that stopped working stops every call once the balance runs out, so it is told by email too
          await notify(wsId, 'money', `topup-failed:${o.id}`, {
            title: confirm ? 'An automatic top up needs your confirmation' : 'An automatic top up was declined',
            lines: [
              confirm ? 'Your bank asked for you to confirm this top up in person, so automatic top ups are off for now.'
                : `Your card was declined (${code}), so automatic top ups are off.`,
              'Calls through Understudy stop when the balance runs out. Add credit in Settings to carry on.',
            ],
            path: '/settings', linkText: 'Update your card',
          });
        }
        break;
      case 'charge.refunded':
        if (wsId) await takeBack(wsId, o.id, (o.amount_refunded ?? 0) / 100, 'refund', 'Refunded to your card');
        break;
      /* A dispute takes its amount off the balance when the money actually leaves: at once for a
         chargeback, and never for an inquiry, where the bank only asks a question and Stripe takes nothing
         (its status starts "warning_"). An inquiry that turns into a chargeback withdraws the money then,
         which Stripe tells us as funds_withdrawn. Taking it back is keyed on the dispute, so however many
         of these arrive, it comes off once. Automatic top up goes off with the first money taken. */
      case 'charge.dispute.created':
      case 'charge.dispute.funds_withdrawn':
        if (wsId) {
          const inquiry = event.type === 'charge.dispute.created' && String(o.status || '').startsWith('warning_');
          if (inquiry) {
            await addActivity(wsId, {
              kind: 'bill', title: 'Your bank asked about a payment',
              detail: 'Nothing has been taken off your balance. If the question becomes a dispute, the payment\'s credit comes off then.',
            });
          } else {
            await takeBack(wsId, o.id, (o.amount ?? 0) / 100, 'dispute', 'Disputed with your bank');
            await db.prepare('UPDATE billing_accounts SET auto_topup = 0, updated_at = ? WHERE workspace_id = ?').run(now(), wsId);
          }
        }
        break;
      /* A dispute the bank decides for us returns the payment to us, so what was taken off the balance
         is given back, once. An inquiry closed for us took nothing, so there is nothing to give back. */
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_reinstated':
        if (wsId && (event.type === 'charge.dispute.funds_reinstated' || o.status === 'won')) {
          await giveBackDispute(wsId, o.id);
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
  /* What was already taken is read and the rest taken in one transaction, behind the account's row
     lock. Read outside it, two partial refunds arriving together each saw nothing taken yet, and
     refunds totalling $10 took $15. */
  const out = await db.tx(async (tx) => {
    await account(workspaceId, tx);
    await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(workspaceId);
    const taken = Number((await tx.prepare(
      `SELECT COALESCE(SUM(-amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND ref LIKE ?`)
      .get(workspaceId, `${prefix}:%`))?.s ?? 0);
    const more = Math.round((totalUsd - taken) * 100) / 100;
    if (!(more > 0)) return null;
    return { more, r: await move(workspaceId, {
      kind, amountUsd: -more, note, ref: `${prefix}:${Math.round(totalUsd * 100)}`,
    }, tx) };
  });
  if (!out) return;
  const { more, r } = out;
  if (!r.duplicate) {
    /* A refund switches automatic top up off, as a dispute does: the balance it lowers would otherwise
       be charged straight back to the same card, within the hour, undoing the refund. */
    const wasOn = kind === 'refund' && (await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, updated_at = ?
        WHERE workspace_id = ? AND auto_topup = 1 RETURNING workspace_id`).run(now(), workspaceId)).rows.length > 0;
    await addActivity(workspaceId, {
      kind: 'bill', title: `$${more.toFixed(2)} came off your balance`,
      detail: kind === 'dispute'
        ? 'A payment was disputed with your bank, so its credit was taken back and automatic top up is off.'
        : `A payment was refunded to your card, so its credit was taken back.${wasOn
          ? ' Automatic top up is off, so the card is not charged again; switch it back on in Settings.' : ''}`,
    });
  }
}

async function saveCard(workspaceId, s, paymentMethodId, customerId) {
  const pm = await s.paymentMethods.retrieve(paymentMethodId);
  await db.prepare(`UPDATE billing_accounts SET payment_method = ?, stripe_customer = COALESCE(stripe_customer, ?),
              card_brand = ?, card_last4 = ?, card_for_topups = 1, updated_at = ? WHERE workspace_id = ?`)
    .run(paymentMethodId, customerId ?? null, pm.card?.brand ?? null, pm.card?.last4 ?? null, now(), workspaceId);
  await account(workspaceId);
}

/* What a dispute took, given back when it is decided for us. Keyed on the dispute, so however many
   times Stripe says so, it is given back once. */
async function giveBackDispute(workspaceId, disputeId) {
  const r = await db.tx(async (tx) => {
    await account(workspaceId, tx);
    await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(workspaceId);
    const taken = Number((await tx.prepare(
      `SELECT COALESCE(SUM(-amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND ref LIKE ?`)
      .get(workspaceId, `dispute:${disputeId}:%`))?.s ?? 0);
    if (!(taken > 0)) return null;
    return { taken, m: await move(workspaceId, {
      kind: 'credit', amountUsd: taken, note: 'A disputed payment was upheld by the bank', ref: `dispute-won:${disputeId}`,
    }, tx) };
  });
  if (r && !r.m.duplicate) {
    await addActivity(workspaceId, {
      kind: 'bill', title: `$${r.taken.toFixed(2)} is back on your balance`,
      detail: 'The bank upheld a payment that had been disputed, so its credit is back on your balance. Automatic top up stays off until you switch it on.',
    });
  }
}
