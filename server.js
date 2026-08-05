const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); 
app.use(express.json());

// استقبال البيانات من موقعك (Vercel)
app.post('/api/order', (req, res) => {
    const orderData = req.body;
    
    console.log("✅ نجاح! تم استلام طلبية جديدة من موقعك:");
    console.log("الاسم:", orderData.customerName);
    console.log("الهاتف:", orderData.phone);
    console.log("السعر الإجمالي:", orderData.totalPrice);
    
    // إرسال رد فوري لموقعك بنجاح العملية
    res.status(200).json({ success: true, message: "تم الاستلام بنجاح" });
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc يعمل على المنفذ ${PORT} وجاهز لاستقبال الطلبات...`);
});
