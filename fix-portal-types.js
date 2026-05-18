/**
 * backend/fix-portal-types.js
 *
 * Checks each ClientPortal against its order's orderType and fixes mismatches.
 * Run once:  node fix-portal-types.js
 */

const dotenv = require('dotenv');
dotenv.config();

const mongoose     = require('mongoose');
const OrderInquiry = require('./models/orderInquiry');
const ClientPortal = require('./models/ClientPortal');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bizManager');
  console.log('✅ Connected to MongoDB\n');

  const portals = await ClientPortal.find({}).lean();
  console.log(`Found ${portals.length} portal(s)\n`);

  for (const portal of portals) {
    const order = await OrderInquiry.findById(portal.orderId).lean();
    if (!order) {
      console.log(`  ⚠️  No order found for portal ${portal.slug} — skipping`);
      continue;
    }

    const correctType = order.orderType || 'product';
    const currentType = portal.type;

    console.log(`  📋  ${portal.slug}`);
    console.log(`      Order type in DB : "${correctType}"`);
    console.log(`      Portal type now  : "${currentType}"`);

    if (correctType !== currentType) {
      await ClientPortal.findByIdAndUpdate(portal._id, { type: correctType });
      console.log(`      ✅ Fixed → set to "${correctType}"\n`);
    } else {
      console.log(`      ✓  Already correct\n`);
    }
  }

  // Also show current state after fixes
  console.log('─'.repeat(50));
  console.log('Final state:');
  const final = await ClientPortal.find({}).select('slug type orderRef clientName status').lean();
  final.forEach(p => {
    console.log(`  ${p.orderRef || p.slug}  →  type: "${p.type}"  status: "${p.status}"`);
  });

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });