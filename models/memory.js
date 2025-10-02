const mongoose = require('mongoose');

const memorySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., "name"
  value: { type: String, required: true },            // e.g., "Venkat"
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Memory', memorySchema);
