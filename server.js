const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors()); // للسماح لموقعك على Vercel بالاتصال بهذا الخادم
app.use(express.json());

// دالة الأتمتة لتسجيل الطلبية في بابا الجزائر
async function submitToBabaAlgeria(order) {
    // إعدادات المتصفح للعمل على الخوادم السحابية
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();

    try {
        console.log("🚀 جاري بدء الأتمتة للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'networkidle2' });
        
        // جلب الإيميل وكلمة السر من المتغيرات السرية (سنقوم بإعدادها لاحقاً لحمايتها)
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        console.log("✅ تم تسجيل الدخول بنجاح");

        // 2. التوجه لصفحة إنشاء طلبية
        await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'networkidle2' });

        // 3. إدخال كود المنتج والسعر
        const productInputs = await page.$$('input[type="text"]');
        if(productInputs.length >= 2) {
            await productInputs[0].type(order.babaId); // كود المنتج
            await productInputs[1].click({ clickCount: 3 }); // مسح السعر القديم
            await productInputs[1].type(order.sellingPrice.toString()); // سعرك
        }

        // 4. إدخال بيانات الزبون (فصل الاسم واللقب)
        const nameParts = order.customerName.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || '.'; 
        
        // التحديد الذكي للحقول باستخدام XPath
        const [firstNameEl] = await page.$x("//label[contains(text(), 'الاسم')]/following-sibling::input");
        if(firstNameEl) await firstNameEl.type(firstName);

        const [lastNameEl] = await page.$x("//label[contains(text(), 'اللقب')]/following-sibling::input");
        if(lastNameEl) await lastNameEl.type(lastName);

        const [phoneEl] = await page.$x("//label[contains(text(), 'الهاتف')]/following-sibling::input");
        if(phoneEl) await phoneEl.type(order.phone);

        const [addressEl] = await page.$x("//label[contains(text(), 'العنوان')]/following-sibling::input");
        if(addressEl) await addressEl.type(order.address);

        // 5. اختيار الولاية
        const [wilayaSelect] = await page.$x("//label[contains(text(), 'ولاية التوصيل')]/following-sibling::select");
        if(wilayaSelect) await wilayaSelect.select(order.wilaya);

        // 6. اختيار نوع التوصيل ومكان الاستلام
        // هذه الأزرار تعتمد على تفاصيل صفحة بابا الجزائر الدقيقة
        if (order.deliveryLocation === 'home') {
            const [homeBtn] = await page.$x("//button[contains(text(), 'للمنزل')]");
            if(homeBtn) await homeBtn.click();
        } else {
            const [deskBtn] = await page.$x("//button[contains(text(), 'للمكتب')]");
            if(deskBtn) await deskBtn.click();
        }

        // 7. النقر على زر "إرسال الطلبية"
        const [submitBtn] = await page.$x("//button[contains(text(), 'إرسال الطلبية')]");
        if(submitBtn) {
            // await submitBtn.click(); // قمنا بتعطيلها مؤقتاً للتجربة فقط حتى لا نرسل طلبيات وهمية
            console.log("✅ اكتملت تعبئة البيانات وجاهزة للإرسال!");
        }

        return { success: true, message: "Order processed successfully" };

    } catch (error) {
        console.error("❌ حدث خطأ أثناء الأتمتة:", error);
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

// استقبال البيانات من موقعك (Vercel)
app.post('/api/order', async (req, res) => {
    const orderData = req.body;
    
    // تشغيل البوت
    const result = await submitToBabaAlgeria(orderData);
    
    if(result.success) {
        res.status(200).json(result);
    } else {
        res.status(500).json(result);
    }
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc يعمل على المنفذ ${PORT}`);
});
