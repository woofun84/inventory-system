/**
 * 供应商
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');

const router = express.Router();

// --- 供应商 ---
router.get('/api/suppliers', requirePerm('suppliers', 'view'), (req, res) => {
  res.json(db.prepare("SELECT * FROM suppliers ORDER BY name").all());
});

router.post('/api/suppliers', requirePerm('suppliers', 'create'), (req, res) => {
  try {
    db.prepare("INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)").run(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/suppliers/:id', requirePerm('suppliers', 'edit'), (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET name=@name,contact=@contact,phone=@phone,remarks=@remarks WHERE id=@id").run({ ...req.body, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/suppliers/:id', requirePerm('suppliers', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM suppliers WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
