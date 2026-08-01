const { popJob } = require('../src/redis/redisClient');
const { completeDonation } = require('../src/services/paymentCompletion.service');
const { donationModel } = require('../src/models/donation.model');
const { createRazorpayInstance } = require('../src/controllers/payment.controller');

const QUEUE = 'payments:jobs';

async function processJob(job) {
  try {
    if (!job || !job.event) return;
    switch (job.event) {
      case 'payment.captured': {
        const payment = job.payload && job.payload.payment && job.payload.payment.entity;
        if (!payment) break;
        const orderId = payment.order_id;
        if (!orderId) break;
        const completedDonation = await completeDonation({ orderId, paymentId: payment.id });
        if (completedDonation) {
          if (completedDonation.status === 'completed') {
            console.log('Worker: Donation marked completed for order', orderId);
          } else {
            console.log('Worker: Donation already processed for order', orderId);
          }
        } else {
          console.warn('Worker: Donation not found for order:', orderId);
        }
        break;
      }
      case 'payment.failed': {
        const payment = job.payload && job.payload.payment && job.payload.payment.entity;
        if (!payment) break;
        const orderId = payment.order_id;
        if (!orderId) break;

        const donation = await donationModel.findOne({ razorpayOrderId: orderId });
        if (!donation) {
          console.warn('Worker: Donation not found for failed order:', orderId);
          break;
        }
        if (donation.status !== 'pending') {
          console.log('Worker: Donation for order', orderId, 'is already', donation.status, '— skipping failed update');
          break;
        }

        // Double-check with Razorpay directly before failing — a retry on
        // the same order may have succeeded even though this event says failed.
        try {
          const created = createRazorpayInstance(donation.paymentAccount);
          if (created) {
            const payments = await created.instance.orders.fetchPayments(orderId);
            const captured = (payments.items || []).find((p) => p.status === 'captured');
            if (captured) {
              await completeDonation({ orderId, paymentId: captured.id });
              console.log('Worker: payment.failed event but found captured payment for order', orderId, '— marked completed instead');
              break;
            }
          }
        } catch (checkErr) {
          console.warn('Worker: Razorpay re-check failed for order', orderId, checkErr && checkErr.message ? checkErr.message : checkErr);
          // fall through and mark failed anyway based on the webhook event
        }

        await donationModel.findByIdAndUpdate(donation._id, {
          status: 'failed',
          razorpayPaymentId: payment.id,
        });
        console.log('Worker: Donation marked failed for order', orderId);
        break;
      }
      case 'subscription.charged': {
        // Fires for every successful monthly autopay charge (including the
        // first). We create one donation record per charge so each month is
        // tracked, receipted and DCC-synced like a normal donation.
        const payment = job.payload && job.payload.payment && job.payload.payment.entity;
        const subscription = job.payload && job.payload.subscription && job.payload.subscription.entity;
        const subId = (subscription && subscription.id) || (payment && payment.subscription_id);
        if (!payment || !subId) break;

        // Idempotency — this exact charge already recorded?
        const already = await donationModel.findOne({ razorpayPaymentId: payment.id });
        if (already) {
          console.log('Worker: subscription charge already recorded', payment.id);
          break;
        }

        // The record created when the donor authorised the subscription.
        const original = await donationModel.findOne({ subscriptionId: subId }).sort({ createdAt: 1 });
        if (!original) {
          console.warn('Worker: no donation found for subscription', subId);
          break;
        }

        if (original.status === 'pending') {
          // First charge — complete the record we already created at signup.
          await completeDonation({ donationId: original._id, paymentId: payment.id });
          console.log('Worker: subscription first charge completed', subId);
        } else {
          // A later monthly charge — clone the original into a fresh record.
          const src = original.toObject();
          [
            '_id', '__v', 'createdAt', 'updatedAt', 'date',
            'razorpayOrderId', 'razorpayPaymentId', 'transactionId',
            'receiptNumber', 'receiptGeneratedAt',
            'lastPaymentDate',
            'dccSyncedAt', 'dccLastAttemptAt', 'dccSyncError', 'dccPayload', 'dccResponse',
            'whatsappReceiptSentAt', 'whatsappReceiptError',
          ].forEach((k) => delete src[k]);
          const clone = await donationModel.create({
            ...src,
            amount: payment.amount ? payment.amount / 100 : original.amount,
            status: 'pending',
            dccSyncStatus: 'pending',
          });
          await completeDonation({ donationId: clone._id, paymentId: payment.id });
          console.log('Worker: subscription recurring charge recorded', subId, payment.id);
        }
        // Track when this subscription last charged — useful for admin visibility.
        await donationModel.findByIdAndUpdate(original._id, { lastPaymentDate: new Date() });
        break;
      }
      case 'subscription.activated': {
        const sub = job.payload && job.payload.subscription && job.payload.subscription.entity;
        if (!sub) break;
        await donationModel.findOneAndUpdate({ subscriptionId: sub.id }, { status: 'active' });
        console.log('Worker: subscription activated', sub.id);
        break;
      }
      case 'subscription.cancelled': {
        const sub = job.payload && job.payload.subscription && job.payload.subscription.entity;
        if (!sub) break;
        await donationModel.updateMany(
          { subscriptionId: sub.id, isRecurring: true, status: { $nin: ['completed', 'cancelled'] } },
          { status: 'cancelled' },
        );
        console.log('Worker: subscription cancelled', sub.id);
        break;
      }
      case 'subscription.completed': {
        const sub = job.payload && job.payload.subscription && job.payload.subscription.entity;
        if (!sub) break;
        await donationModel.findOneAndUpdate(
          { subscriptionId: sub.id, isRecurring: true, status: 'active' },
          { status: 'completed' },
        );
        console.log('Worker: subscription completed', sub.id);
        break;
      }
      default:
        console.log('Worker: Unhandled job event', job.event);
    }
  } catch (err) {
    console.error('Worker: job processing error', err && err.stack ? err.stack : err);
  }
}

async function run() {
  console.log('Payment worker started, listening to', QUEUE);
  while (true) {
    try {
      const job = await popJob(QUEUE, 5);
      if (!job) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      await processJob(job);
    } catch (err) {
      console.error('Worker loop error', err && err.stack ? err.stack : err);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

run().catch(err => {
  console.error('Worker failed', err && err.stack ? err.stack : err);
  process.exit(1);
});
