const mongoose = require('mongoose');

mongoose.connect('mongodb://127.0.0.1:27017/bizManager').then(async () => {
  const col = mongoose.connection.collection('users');

  await col.updateOne(
    { email: 'akarsh014@gmail.com' },
    { $set: { isActive: true, role: 'admin' } }
  );

  const u = await col.findOne({ email: 'akarsh014@gmail.com' });
  console.log('Email   :', u.email);
  console.log('Role    :', u.role);
  console.log('isActive:', u.isActive);
  console.log(u.isActive === true ? '✅ Ready — you can now log in' : '❌ Still not active');

  await mongoose.disconnect();
}).catch(err => { console.error(err); process.exit(1); });