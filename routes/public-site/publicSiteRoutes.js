'use strict';
/**
 * backend/routes/public-site/publicSiteRoutes.js
 *
 * Mounted at /api/public-site in server.js.
 *
 * ─── WHO CALLS WHAT ──────────────────────────────────────────────────────────
 *
 * PUBLIC (marqlandstudios.com visitors — no auth):
 *   GET  /store     — categories + testimonials for the homepage
 *   POST /inquiry   — contact form submission
 *
 * ADMIN (marqlandstudios-admin, Marqland team only — JWT + admin role):
 *   The routes below manage the *content* displayed on the public site.
 *   They are operated by the team from the admin panel, not by website visitors.
 *   POST   /categories
 *   DELETE /categories/:catId
 *   PUT    /categories/:catId/cover/:imgId
 *   POST   /categories/:catId/subcategories
 *   PUT    /categories/:catId/subcategories/:subId
 *   DELETE /categories/:catId/subcategories/:subId
 *   POST   /upload/:catId
 *   POST   /upload/:catId/sub/:subId
 *   DELETE /images/:catId/:imgId
 *   DELETE /images/:catId/sub/:subId/:imgId
 *   PUT    /reorder/:catId
 *   PUT    /reorder/:catId/sub/:subId
 *   POST   /testimonials
 *   PUT    /testimonials/:id
 *   DELETE /testimonials/:id
 *   GET    /inquiries
 *   DELETE /inquiries/:id
 *   PATCH  /inquiries/:id/read
 *
 * ─── UPLOAD STRUCTURE ────────────────────────────────────────────────────────
 *   Category images:    uploads/publicApp/category/<CategoryName>/filename
 *   Subcategory images: uploads/publicApp/category/<CategoryName>/<SubName>/filename
 *   Testimonial photos: uploads/publicApp/testimonials/filename
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const sharp    = require('sharp');

const StoreCategory = require('../../models/public-site/StoreCategory');
const Testimonial   = require('../../models/public-site/Testimonial');
const PublicInquiry = require('../../models/public-site/PublicInquiry');
const { authenticate, authorize } = require('../../middleware/authMiddleware');
const logger = require('../../utils/logger').child({ module: 'publicSiteRoutes' });

// ─── Auth guard ───────────────────────────────────────────────────────────────
// Declared at the top so it can safely be referenced by any route below.
// Without this, registering a route before this line would silently skip auth.
const adminOnly = [authenticate, authorize(['admin'])];

// ─── Upload directory helpers ─────────────────────────────────────────────────
const PUBLIC_APP_BASE = path.join(process.cwd(), 'public', 'uploads', 'publicApp');

/** Sanitise a user-provided name to a safe folder component. */
const safeName = (name) =>
  (name || 'uncategorised').trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_');

const getCategoryDir = (categoryName) => {
  const dir = path.join(PUBLIC_APP_BASE, 'category', safeName(categoryName));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getSubcategoryDir = (categoryName, subcategoryName) => {
  const dir = path.join(
    PUBLIC_APP_BASE, 'category', safeName(categoryName), safeName(subcategoryName)
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getTestimonialDir = () => {
  const dir = path.join(PUBLIC_APP_BASE, 'testimonials');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getCategoryUrl    = (cat, filename) =>
  `/uploads/publicApp/category/${safeName(cat)}/${filename}`;
const getSubcategoryUrl = (cat, sub, filename) =>
  `/uploads/publicApp/category/${safeName(cat)}/${safeName(sub)}/${filename}`;
const getTestimonialUrl = (filename) =>
  `/uploads/publicApp/testimonials/${filename}`;

// ─── Disk helpers ─────────────────────────────────────────────────────────────

/**
 * Delete a single file from disk. Logs a warning on failure — never throws.
 * @param {string} urlPath  e.g. '/uploads/publicApp/category/Gifts/img.webp'
 */
const deleteFileSafe = (urlPath) => {
  const fp = path.join(process.cwd(), 'public', urlPath);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (e) {
    logger.warn('File delete failed', { path: fp, error: e.message });
  }
};

/**
 * Recursively delete a directory. Uses fs.rmSync (not the deprecated rmdirSync)
 * so it works even if the directory still has files in it (e.g. a previous
 * individual file delete silently failed). Never throws.
 */
const deleteDirSafe = (dirPath) => {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (e) {
    logger.warn('Directory delete failed', { path: dirPath, error: e.message });
  }
};

// ─── Multer — memory storage ──────────────────────────────────────────────────
// Memory storage is necessary because the on-disk destination depends on the
// category/subcategory name, which must be resolved from MongoDB after multer
// parses the request. Files are written to disk manually in each route handler.
const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files allowed.')),
});

const testimonialUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files allowed.')),
});

// ─── Image processing helpers ─────────────────────────────────────────────────

/** Normalise any input format to WebP and write to destDir. Returns filename. */
const saveImageBuffer = async (buffer, destDir) => {
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;
  await sharp(buffer)
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toFile(path.join(destDir, filename));
  return filename;
};

/** Extract width/height aspect ratio. Returns null if sharp can't read the buffer. */
const getAspectRatio = async (buffer) => {
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (width && height) return width / height;
  } catch { /* non-critical */ }
  return null;
};

// ─── Public store payload ─────────────────────────────────────────────────────
/**
 * Returns only what the public site homepage needs: categories + testimonials.
 *
 * IMPORTANT: Inquiries are intentionally excluded from this payload.
 * GET /store is unauthenticated and open to the internet — including inquiries
 * would expose the name, email, phone, and message of every person who has
 * submitted the contact form. Inquiries are served separately via
 * GET /inquiries which is admin-only.
 */
const buildStorePayload = async () => {
  const [categories, testimonials] = await Promise.all([
    StoreCategory.find().sort({ order: 1, createdAt: 1 }).lean(),
    Testimonial.find().sort({ order: 1, createdAt: 1 }).lean(),
  ]);

  const shapedCategories = categories.map(cat => ({
    id:   cat._id.toString(),
    name: cat.name,
    images: (cat.images || [])
      .sort((a, b) => a.order - b.order)
      .map(img => ({
        id:          img._id.toString(),
        url:         img.url,
        isCover:     img.isCover,
        aspectRatio: img.aspectRatio,
      })),
    subcategories: (cat.subcategories || [])
      .sort((a, b) => a.order - b.order)
      .map(sub => ({
        id:   sub._id.toString(),
        name: sub.name,
        images: (sub.images || [])
          .sort((a, b) => a.order - b.order)
          .map(img => ({
            id:          img._id.toString(),
            url:         img.url,
            aspectRatio: img.aspectRatio,
          })),
      })),
  }));

  const shapedTestimonials = testimonials.map(t => ({
    id:       t._id.toString(),
    author:   t.author,
    company:  t.company,
    role:     t.role,
    feedback: t.text,
    content:  t.text,  // dual-key: some frontend components use one, some the other
    imageUrl: t.imageUrl || '',
  }));

  return { categories: shapedCategories, testimonials: shapedTestimonials };
};


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — no auth, called by marqlandstudios.com visitors
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /store
 * Full homepage data: categories (with images) + testimonials.
 * Inquiries are NOT included — see buildStorePayload comment above.
 */
router.get('/store', async (req, res) => {
  try {
    const payload = await buildStorePayload();
    logger.debug('Public store payload served', {
      categories:   payload.categories.length,
      testimonials: payload.testimonials.length,
    });
    res.json(payload);
  } catch (err) {
    logger.error('Failed to build store payload', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /inquiry
 * Contact form submission from marqlandstudios.com.
 */
router.post('/inquiry', async (req, res) => {
  try {
    const { name, company, email, phone, message, hearAbout } = req.body;
    if (!name?.trim() || !email?.trim())
      return res.status(400).json({ message: 'Name and email are required.' });

    const inq = await PublicInquiry.create({ name, company, email, phone, message, hearAbout });
    logger.info('Public inquiry received', { inquiryId: inq._id, email });
    res.status(201).json({ message: 'Inquiry received.', id: inq._id });
  } catch (err) {
    logger.error('Public inquiry creation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — JWT required, admin role only
// Called by marqlandstudios-admin to manage the public site content.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Categories ────────────────────────────────────────────────────────────────

router.post('/categories', adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required.' });

    const count = await StoreCategory.countDocuments();
    const cat   = await StoreCategory.create({ name: name.trim(), order: count });
    logger.info('Category created', { categoryId: cat._id, name: cat.name, userId: req.user?.id });
    res.status(201).json({ id: cat._id, name: cat.name });
  } catch (err) {
    logger.error('Category creation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/categories/:catId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findByIdAndDelete(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    // Delete all image files first, then the entire folder.
    // Using deleteDirSafe (fs.rmSync recursive) instead of the old rmdirSync —
    // rmdirSync throws if the directory is not empty, which happens whenever a
    // previous individual deleteFileSafe silently failed.
    (cat.images || []).forEach(img => deleteFileSafe(img.url));
    (cat.subcategories || []).forEach(sub =>
      (sub.images || []).forEach(img => deleteFileSafe(img.url))
    );
    deleteDirSafe(getCategoryDir(cat.name));

    logger.info('Category deleted', { categoryId: req.params.catId, name: cat.name, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Category delete failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/categories/:catId/cover/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    cat.images.forEach(img => { img.isCover = (img._id.toString() === req.params.imgId); });
    await cat.save();

    logger.info('Category cover updated', { categoryId: req.params.catId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Cover updated.' });
  } catch (err) {
    logger.error('Category cover update failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Subcategories ─────────────────────────────────────────────────────────────

router.post('/categories/:catId/subcategories', adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    cat.subcategories.push({ name: name.trim(), order: cat.subcategories.length });
    await cat.save();

    const newSub = cat.subcategories[cat.subcategories.length - 1];
    logger.info('Subcategory created', { categoryId: req.params.catId, subId: newSub._id, name: newSub.name, userId: req.user?.id });
    res.status(201).json({ id: newSub._id, name: newSub.name });
  } catch (err) {
    logger.error('Subcategory creation failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/categories/:catId/subcategories/:subId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    sub.name = req.body.name?.trim() || sub.name;
    await cat.save();

    logger.info('Subcategory renamed', { categoryId: req.params.catId, subId: req.params.subId, name: sub.name, userId: req.user?.id });
    res.json({ id: sub._id, name: sub.name });
  } catch (err) {
    logger.error('Subcategory rename failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/categories/:catId/subcategories/:subId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    (sub.images || []).forEach(img => deleteFileSafe(img.url));
    sub.deleteOne();
    await cat.save();

    logger.info('Subcategory deleted', { categoryId: req.params.catId, subId: req.params.subId, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Subcategory delete failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Image upload ──────────────────────────────────────────────────────────────

router.post('/upload/:catId', adminOnly, upload.array('image', 20), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    const destDir   = getCategoryDir(cat.name);
    const baseOrder = cat.images?.length || 0;

    // getAspectRatio and saveImageBuffer both read the same buffer — run them
    // in parallel per file to halve the sharp processing time on bulk uploads.
    const newImages = await Promise.all(req.files.map(async (file, i) => {
      const [aspectRatio, filename] = await Promise.all([
        getAspectRatio(file.buffer),
        saveImageBuffer(file.buffer, destDir),
      ]);
      return { url: getCategoryUrl(cat.name, filename), filename, isCover: false, aspectRatio, order: baseOrder + i };
    }));

    cat.images.push(...newImages);
    // Auto-set first image as cover if no cover exists yet
    if (!cat.images.some(img => img.isCover)) cat.images[0].isCover = true;
    await cat.save();

    logger.info('Category images uploaded', { categoryId: req.params.catId, name: cat.name, count: req.files.length, userId: req.user?.id });
    res.json({ message: `${req.files.length} image(s) uploaded.` });
  } catch (err) {
    logger.error('Category image upload failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.post('/upload/:catId/sub/:subId', adminOnly, upload.array('image', 20), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ message: 'No files uploaded.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    const destDir   = getSubcategoryDir(cat.name, sub.name);
    const baseOrder = sub.images?.length || 0;

    const newImages = await Promise.all(req.files.map(async (file, i) => {
      const [aspectRatio, filename] = await Promise.all([
        getAspectRatio(file.buffer),
        saveImageBuffer(file.buffer, destDir),
      ]);
      return { url: getSubcategoryUrl(cat.name, sub.name, filename), filename, isCover: false, aspectRatio, order: baseOrder + i };
    }));

    sub.images.push(...newImages);
    await cat.save();

    logger.info('Subcategory images uploaded', { categoryId: req.params.catId, subId: req.params.subId, subName: sub.name, count: req.files.length, userId: req.user?.id });
    res.json({ message: `${req.files.length} image(s) uploaded.` });
  } catch (err) {
    logger.error('Subcategory image upload failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Image deletion ────────────────────────────────────────────────────────────

router.delete('/images/:catId/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const img = cat.images.id(req.params.imgId);
    if (!img) return res.status(404).json({ message: 'Image not found.' });

    deleteFileSafe(img.url);
    img.deleteOne();
    await cat.save();

    logger.info('Category image deleted', { categoryId: req.params.catId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Image deleted.' });
  } catch (err) {
    logger.error('Category image delete failed', { categoryId: req.params.catId, imgId: req.params.imgId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/images/:catId/sub/:subId/:imgId', adminOnly, async (req, res) => {
  try {
    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });
    const img = sub.images.id(req.params.imgId);
    if (!img) return res.status(404).json({ message: 'Image not found.' });

    deleteFileSafe(img.url);
    img.deleteOne();
    await cat.save();

    logger.info('Subcategory image deleted', { categoryId: req.params.catId, subId: req.params.subId, imgId: req.params.imgId, userId: req.user?.id });
    res.json({ message: 'Image deleted.' });
  } catch (err) {
    logger.error('Subcategory image delete failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Image reorder ─────────────────────────────────────────────────────────────

router.put('/reorder/:catId', adminOnly, async (req, res) => {
  try {
    const { imageIds } = req.body;
    if (!Array.isArray(imageIds)) return res.status(400).json({ message: 'imageIds array required.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });

    imageIds.forEach((id, idx) => {
      const img = cat.images.id(id);
      if (img) img.order = idx;
    });
    await cat.save();

    logger.info('Category images reordered', { categoryId: req.params.catId, count: imageIds.length, userId: req.user?.id });
    res.json({ message: 'Order updated.' });
  } catch (err) {
    logger.error('Category reorder failed', { categoryId: req.params.catId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/reorder/:catId/sub/:subId', adminOnly, async (req, res) => {
  try {
    const { imageIds } = req.body;
    if (!Array.isArray(imageIds)) return res.status(400).json({ message: 'imageIds array required.' });

    const cat = await StoreCategory.findById(req.params.catId);
    if (!cat) return res.status(404).json({ message: 'Category not found.' });
    const sub = cat.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ message: 'Subcategory not found.' });

    imageIds.forEach((id, idx) => {
      const img = sub.images.id(id);
      if (img) img.order = idx;
    });
    await cat.save();

    logger.info('Subcategory images reordered', { categoryId: req.params.catId, subId: req.params.subId, count: imageIds.length, userId: req.user?.id });
    res.json({ message: 'Order updated.' });
  } catch (err) {
    logger.error('Subcategory reorder failed', { categoryId: req.params.catId, subId: req.params.subId, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Testimonials ──────────────────────────────────────────────────────────────

router.post('/testimonials', adminOnly, testimonialUpload.single('photo'), async (req, res) => {
  try {
    const { author, company, role, text } = req.body;
    if (!author?.trim() || !text?.trim())
      return res.status(400).json({ message: 'Author and text are required.' });

    let imageUrl = '';
    if (req.file) {
      const filename = await saveImageBuffer(req.file.buffer, getTestimonialDir());
      imageUrl = getTestimonialUrl(filename);
    }

    const count = await Testimonial.countDocuments();
    const t = await Testimonial.create({ author, company, role, text, imageUrl, order: count });

    logger.info('Testimonial created', { testimonialId: t._id, author, userId: req.user?.id });
    res.status(201).json({ id: t._id, author: t.author, company: t.company, role: t.role, text: t.text, imageUrl: t.imageUrl });
  } catch (err) {
    logger.error('Testimonial creation failed', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.put('/testimonials/:id', adminOnly, testimonialUpload.single('photo'), async (req, res) => {
  try {
    const existing = await Testimonial.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Testimonial not found.' });

    let imageUrl = existing.imageUrl;
    if (req.file) {
      if (existing.imageUrl) deleteFileSafe(existing.imageUrl);
      const filename = await saveImageBuffer(req.file.buffer, getTestimonialDir());
      imageUrl = getTestimonialUrl(filename);
    }

    const { author, company, role, text } = req.body;
    const t = await Testimonial.findByIdAndUpdate(
      req.params.id,
      { author, company, role, text, imageUrl },
      { new: true }
    );

    logger.info('Testimonial updated', { testimonialId: req.params.id, userId: req.user?.id });
    res.json({ id: t._id, author: t.author, company: t.company, role: t.role, text: t.text, imageUrl: t.imageUrl });
  } catch (err) {
    logger.error('Testimonial update failed', { testimonialId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/testimonials/:id', adminOnly, async (req, res) => {
  try {
    const t = await Testimonial.findByIdAndDelete(req.params.id);
    if (!t) return res.status(404).json({ message: 'Testimonial not found.' });
    if (t.imageUrl) deleteFileSafe(t.imageUrl);
    logger.info('Testimonial deleted', { testimonialId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Testimonial delete failed', { testimonialId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

// ── Inquiries (admin only) ────────────────────────────────────────────────────

router.get('/inquiries', adminOnly, async (req, res) => {
  try {
    const inquiries = await PublicInquiry.find().sort({ createdAt: -1 }).lean();
    logger.debug('Admin inquiries listed', { count: inquiries.length, userId: req.user?.id });
    res.json(inquiries.map(i => ({
      id: i._id.toString(), name: i.name, company: i.company,
      email: i.email, phone: i.phone, message: i.message,
      hearAbout: i.hearAbout, read: i.read, createdAt: i.createdAt,
    })));
  } catch (err) {
    logger.error('Failed to list inquiries', { error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/inquiries/:id', adminOnly, async (req, res) => {
  try {
    const inq = await PublicInquiry.findByIdAndDelete(req.params.id);
    if (!inq) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry deleted', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('Inquiry delete failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

router.patch('/inquiries/:id/read', adminOnly, async (req, res) => {
  try {
    const inq = await PublicInquiry.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!inq) return res.status(404).json({ message: 'Inquiry not found.' });
    logger.info('Inquiry marked read', { inquiryId: req.params.id, userId: req.user?.id });
    res.json({ id: inq._id, read: inq.read });
  } catch (err) {
    logger.error('Inquiry mark-read failed', { inquiryId: req.params.id, error: err.message, stack: err.stack });
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;