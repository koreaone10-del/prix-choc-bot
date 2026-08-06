const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

async function submitToBabaAlgeria(order) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log("🚀 بدء الأتمتة للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        console.log("⏳ جاري فتح صفحة الدخول...");
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        await page.click('button[type="submit"]');
        
        console.log("⏳ ننتظر الدخول...");
        await new Promise(r => setTimeout(r, 5000)); 

        // 2. التوجه لصفحة إنشاء طلبية
        console.log("⏳ جاري فتح صفحة إضافة طلبية...");
        await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000)); 

        // 3. إدخال كود المنتج والسعر
        console.log("📦 جاري إدخال بيانات المنتج...");
        const productInputs = await page.$$('input[type="text"]');
        if(productInputs.length >= 2) {
            await productInputs[0].type(order.babaId, { delay: 50 }); 
            await page.keyboard.press('Enter'); 
            await new Promise(r => setTimeout(r, 1500)); 
            
            await productInputs[1].click({ clickCount: 3 }); 
            await productInputs[1].type(order.sellingPrice.toString()); 
        }

        // 4. إدخال بيانات الزبون
        console.log("👤 جاري إدخال معلومات الزبون...");
        const nameParts = order.customerName.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || '.'; 
        
        const typeInput = async (label, text) => {
            try {
                const [el] = await page.$x(`//label[contains(text(), '${label}')]/following-sibling::input`);
                if(el) await el.type(text);
            } catch(e) { console.log(`⚠️ لم يتم العثور على حقل: ${label}`); }
        };

        await typeInput('الاسم', firstName);
        await typeInput('اللقب', lastName);
        await typeInput('الهاتف', order.phone);

        const finalAddress = (order.commune ? order.commune + " - " : "") + order.address;
        await typeInput('العنوان', finalAddress);

        // 5. الاختيار الذكي للولاية بقراءة النص العربي (كما طلبت تماماً)
        console.log(`🗺️ جاري قراءة القائمة للبحث عن الولاية: ${order.wilaya}...`);
        try {
            const [wilayaSelect] = await page.$x("//label[contains(text(), 'ولاية التوصيل')]/following-sibling::select");
            if (wilayaSelect) {
                const valueToSelect = await page.evaluate((sel, wilayaName) => {
                    // دالة ذكية لتنظيف النص العربي لتفادي أخطاء الحروف المتشابهة
                    const cleanArabic = (text) => text.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').trim();
                    const targetName = cleanArabic(wilayaName);
                    
                    // البحث في كل خيارات بابا الجزائر ومطابقتها مع ولاية الزبون
                    for (let option of sel.options) {
                        const optionText = cleanArabic(option.text);
                        if (optionText.includes(targetName) || targetName.includes(optionText)) {
                            return option.value; // جلب الكود السري للولاية
                        }
                    }
                    return null;
                }, wilayaSelect, order.wilaya);

                if (valueToSelect) {
                    await wilayaSelect.select(valueToSelect); // تفعيل الولاية رسمياً في الموقع
                    console.log(`✅ تم إيجاد الولاية بنجاح واختيارها!`);
                } else {
                    console.log(`⚠️ لم يتطابق اسم الولاية: ${order.wilaya}`);
                }
            }
        } catch(e) { console.log("⚠️ خطأ في قراءة قائمة الولايات"); }

        // 6. اختيار مكان الاستلام
        console.log("🚚 جاري تحديد مكان الاستلام...");
        try {
            if (order.deliveryLocation === 'home') {
                const [homeBtn] = await page.$x("//button[contains(text(), 'للمنزل')]");
                if(homeBtn) await homeBtn.click();
            } else {
                const [deskBtn] = await page.$x("//button[contains(text(), 'للمكتب')]");
                if(deskBtn) await deskBtn.click();
            }
        } catch(e) {}

        // 7. النقر على زر الإرسال
        console.log("🎯 جاري الضغط على زر التأكيد النهائي...");
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const submitBtn = buttons.find(b => b.type === 'submit' || b.innerText.includes('إرسال الطلبية'));
            if(submitBtn) {
                submitBtn.scrollIntoView();
                submitBtn.click();
            }
        });

        console.log("⏳ ننتظر استجابة بابا الجزائر...");
        await new Promise(r => setTimeout(r, 4000));
        
        const currentUrl = page.url();
        if (currentUrl.includes('orders') || currentUrl.includes('success')) {
             console.log("🎉 نجاح ساحق! تم تسجيل الطلبية رسمياً.");
        } else {
             console.log("⚠️ تم الضغط على إرسال، لكن الموقع لم ينتقل لصفحة النجاح.");
        }

    } catch (error) {
        console.error("❌ توقف البوت بسبب خطأ:", error.message);
    } finally {
        await browser.close();
        console.log("🔒 تم إغلاق المتصفح الآلي.");
    }
}

app.post('/api/order', (req, res) => {
    const orderData = req.body;
    res.status(200).json({ success: true, message: "Order received" });
    submitToBabaAlgeria(orderData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc يعمل بامتياز على المنفذ ${PORT}`);
});
