const express = require('express');
const router = express.Router();
const Catalogue = require('../models/offsiteCatalogue');

/**
 * @route   POST /api/offsitecatalogues
 * @desc    Create a new offsite catalogue entry
 * @access  Public
 */
router.post('/', async (req, res) => {
  try {
    const { title, description, items, id } = req.body;
    if (id && id !== 'undefined') {
      const updated = await Catalogue.findByIdAndUpdate(id, { title, description, items }, { new: true });
      return res.json(updated);
    }else {
         console.log("inside POST /api/offsitecatalogues ELSE");
      const newCatalogue = new Catalogue(req.body);
      const savedCatalogue = await newCatalogue.save();
      res.status(201).json({
        success: true,
        message: "Offsite Catalogue created successfully",
        data: savedCatalogue
      });
    }
  } catch (error) {
    console.error("POST Offsite Error:", error);
    res.status(400).json({
      success: false,
      message: "Failed to create offsite catalogue",
      error: error.message
    });
  }
});

/**
 * @route   GET /api/offsitecatalogues
 * @desc    Get all offsite catalogues
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const catalogues = await Catalogue.find().sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      count: catalogues.length,
      data: catalogues
    });
  } catch (error) {
    console.error("GET All Offsite Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching offsite catalogues",
      error: error.message
    });
  }
});

/**
 * @route   GET /api/offsitecatalogues/:id
 * @desc    Get a single offsite catalogue by ID
 * @access  Public
 */
router.get('/:id', async (req, res) => {
  try {
    const catalogue = await Catalogue.findById(req.params.id);
    
    if (!catalogue) {
      return res.status(404).json({
        success: false,
        message: "Offsite catalogue not found"
      });
    }

    res.status(200).json({
      success: true,
      data: catalogue
    });
  } catch (error) {
    console.error("GET ID Offsite Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching catalogue details",
      error: error.message
    });
  }
});

/**
 * @route   PUT /api/offsitecatalogues/:id
 * @desc    Update an offsite catalogue by ID
 * @access  Public
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const updatedCatalogue = await Catalogue.findByIdAndUpdate(
      id, 
      updates, 
      { new: true, runValidators: true }
    );

    if (!updatedCatalogue) {
      return res.status(404).json({
        success: false,
        message: `No offsite catalogue found with id: ${id}`
      });
    }

    res.status(200).json({
      success: true,
      message: "Offsite Catalogue Progress Saved Successfully!",
      data: updatedCatalogue 
    });

  } catch (error) {
    console.error("PUT Offsite Error:", error);
    res.status(500).json({
      success: false,
      message: "Database operation failed",
      error: error.message
    });
  }
});

/**
 * @route   DELETE /api/offsitecatalogues/:id
 * @desc    Delete an offsite catalogue by ID
 * @access  Public
 */
router.delete('/:id', async (req, res) => {
  try {
    const deletedCatalogue = await Catalogue.findByIdAndDelete(req.params.id);

    if (!deletedCatalogue) {
      return res.status(404).json({
        success: false,
        message: "Offsite catalogue not found, nothing deleted"
      });
    }

    res.status(200).json({
      success: true,
      message: "Offsite catalogue deleted successfully"
    });
  } catch (error) {
    console.error("DELETE Offsite Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete offsite catalogue",
      error: error.message
    });
  }
});

module.exports = router;