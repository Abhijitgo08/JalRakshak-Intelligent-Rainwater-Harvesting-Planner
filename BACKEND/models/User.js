// models/User.js
const mongoose = require('mongoose');

const LocationOptionSchema = new mongoose.Schema(
  {
    id: { type: String, default: null },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: null },
    distance_m: { type: Number, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const ChosenLocationSchema = new mongoose.Schema(
  {
    id: { type: String, default: null },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
    chosenAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },              // keep your existing constraint
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },

    // optional stable userId used by location routes (may be same as _id or a legacy id)
    userId: { type: String, index: true, sparse: true },

    // location fields
    locationOptions: { type: [LocationOptionSchema], default: [] },
    chosenLocation: { type: ChosenLocationSchema, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

UserSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('User', UserSchema);
