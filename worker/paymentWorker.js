const { popJob } = require('../src/redis/redisClient');
const { completeDonation } = require('../src/services/paymentCompletion.service');

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
