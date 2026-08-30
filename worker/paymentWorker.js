const { connectDb } = require('../src/config/db');
const { popJob } = require('../src/redis/redisClient');
const { completeDonation, handleSubscriptionCharged } = require('../src/services/paymentCompletion.service');
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
        // Shared logic lives in handleSubscriptionCharged (paymentCompletion
        // .service.js) so this queued path and the inline webhook fallback
        // in payment.controller.js never drift apart.
        const result = await handleSubscriptionCharged(job.payload);
        if (result.ok && !result.skipped) {
          console.log('Worker: subscription charge completed', result.donationId);
        } else if (result.skipped) {
          console.log('Worker: subscription charge skipped —', result.reason);
        } else {
          console.warn('Worker: subscription charge could not be processed —', result.reason);
        }
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
  await connectDb();
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
