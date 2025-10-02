// models/Message.js
const mongoose = require('mongoose');

// Define message schema
const messageSchema = new mongoose.Schema({
  text: { type: String, required: true },              // message text
  role: { type: String, enum: ['user','assistant','system'], default: 'user' }, // sender
  language: { type: String, default: 'unknown' },      // detected language code
  createdAt: { type: Date, default: Date.now }         // timestamp
});

// Export Message model
module.exports = mongoose.model('Message', messageSchema);
