/**
 * backend/reset-portals.js
 *
 * 1. Deletes ALL existing ClientPortal documents (they are orphaned — their orders were deleted)
 * 2. Recreates portals correctly from every current order in the DB
 *
 * Run once:
 *   cd backend
 *   node reset-portals.js
 */

const dotenv = require('dotenv');
dotenv.config();

const mongoose     = require('mongoose');
const OrderInquiry = require('./models/orderInquiry');
const ClientPortal = require('./models/ClientPortal');

const slugify = (str) =>
  (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const genToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 5; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
};

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bizManager');
  console.log('✅ Connected to MongoDB\n');

  // Step 1 — delete all existing portals
  const deleted = await ClientPortal.deleteMany({});
  console.log(`🗑  Deleted ${deleted.deletedCount} existing portal(s)\n`);

  // Step 2 — load all current orders
  const orders = await OrderInquiry.find({}).lean();
  console.log(`📋  Found ${orders.length} order(s) in DB\n`);

  if (orders.length === 0) {
    console.log('No orders found. Create orders in Order Tracker first, then portals will auto-create.');
    await mongoose.disconnect();
    return;
  }

  // Step 3 — create one portal per order
  let created = 0, failed = 0;

  for (const order of orders) {
    const slug = `${genToken()}-${slugify(order.refNumber || order._id.toString())}`;
    const type = order.orderType || 'product';

    console.log(`  Creating portal for: ${order.refNumber || order._id}`);
    console.log(`    clientName : ${order.clientName}`);
    console.log(`    orderType  : ${type}`);
    console.log(`    slug       : ${slug}`);

    try {
      await ClientPortal.create({
        orderId:      order._id,
        slug,
        type,
        orderRef:     order.refNumber || '',
        clientName:    order.clientName || '',
        orderPlacedBy: order.orderPlacedBy || '',
        title:         order.title || '',
        status:       order.status === 'completed' ? 'completed' : 'active',
        productItems: [],
        offsiteItems: [],
        messages:     [],
        viewCount:    0,
      });
      console.log(`    ✅ Created (type: ${type})\n`);
      created++;
    } catch (err) {
      console.error(`    ❌ Failed: ${err.message}\n`);
      failed++;
    }
  }

  // Step 4 — show final state
  console.log('─'.repeat(55));
  console.log('Final portal state:\n');
  const final = await ClientPortal.find({})
    .select('slug type orderRef clientName status')
    .lean();

  final.forEach(p => {
    const typeLabel = p.type === 'offsite' ? '🏨 offsite' : '🎁 product';
    console.log(`  ${p.orderRef || p.slug}`);
    console.log(`    type   : ${typeLabel}`);
    console.log(`    client : ${p.clientName}`);
    console.log(`    status : ${p.status}`);
    console.log(`    url    : /p/${p.slug}\n`);
  });

  console.log(`Done. Created: ${created}  Failed: ${failed}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });