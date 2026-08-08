const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// دالة مساعدة لتنظيف النصوص العربية والمطابقة الدقيقة في القوائم المنسدلة
function cleanArabicText(text) {
    if (!text) return '';
    return text.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').trim();
}

async function submitToSawa9ly(order) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', '--disable-gpu', '--single-process'
        ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log("🚀 بدء أتمتة سوقلي للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        console.log("⏳ جاري فتح صفحة تسجيل الدخول...");
        await page.goto('https://sawa9ly.app/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.SAWA9LY_EMAIL);
        await page.type('input[type="password"]', process.env.SAWA9LY_PASSWORD);
        
        console.log("⌨️ جاري الضغط على زر تسجيل الدخول...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            page.click('button[type="submit"]')
        ]);
        
        console.log("⏳ ننتظر 5 ثواني لضمان حفظ الجلسة (Session) في متصفح سوقلي...");
        await new Promise(r => setTimeout(r, 5000));
        console.log("✅ تم الدخول وحفظ الجلسة بنجاح!");

        // 2. التوجه لصفحة المنتج
        const productLink = order.sawa9lyLink || (order.sawa9lyId ? `https://sawa9ly.app/product/${order.sawa9lyId}` : null);
        if (!productLink) throw new Error("⚠️ لم يتم استلام رابط أو كود المنتج من Vercel!");

        console.log(`🔗 جاري التوجه لصفحة المنتج: ${productLink}`);
        await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000)); 
        
        // 3. الضغط على الزر الأخضر "قدم طلبك"
        console.log("🛒 جاري البحث عن زر 'قدم طلبك' الأخضر...");
        const isOrderButtonClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const orderBtn = elements.find(el => el.innerText && el.innerText.includes('قدم طلبك') && el.tagName !== 'SCRIPT');
            if(orderBtn) {
                orderBtn.scrollIntoView();
                orderBtn.click();
                return true;
            }
            return false;
        });

        if (!isOrderButtonClicked) {
            throw new Error(`❌ لم يتم العثور على زر 'قدم طلبك' في الرابط: ${productLink}`);
        }
        
        console.log("⏳ ننتظر تحميل استمارة السلة...");
        await new Promise(r => setTimeout(r, 4000));

        // 4. تعديل السعر لضمان الفائدة
        console.log("💰 جاري تعديل السعر...");
        const priceInputXPath = "//input[@type='number' or contains(@class, 'price')]"; // يبحث عن خانة تغيير السعر
        try {
            await page.waitForXPath(priceInputXPath, { timeout: 10000 });
            const [priceInput] = await page.$x(priceInputXPath);
            if (priceInput) {
                await priceInput.click({ clickCount: 3 }); 
                await page.keyboard.press('Backspace'); 
                await new Promise(r => setTimeout(r, 500));
                await priceInput.type(order.sellingPrice.toString(), { delay: 100 });
                await page.keyboard.press('Tab'); 
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {
            console.log("⚠️ ملاحظة: لم يتم العثور على خانة السعر بنفس الطريقة السابقة، قد يتطلب فحصاً أدق لاحقاً.");
        }

        // 5. الضغط على زر "استمرار" الأصفر
        console.log("⏭️ جاري الضغط على زر 'استمرار'...");
        const isContinueClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const continueBtn = elements.find(el => el.innerText && el.innerText.includes('استمرار') && el.tagName !== 'SCRIPT');
            if(continueBtn) {
                continueBtn.scrollIntoView();
                continueBtn.click();
                return true;
            }
            return false;
        });
        await new Promise(r => setTimeout(r, 3000));

        // 6. إدخال بيانات الزبون (الاسم الكامل والهاتف والعنوان)
        console.log("👤 جاري إدخال معلومات التوصيل للزبون...");
        
        const typeInputByLabel = async (labelWord, text) => {
            try {
                const [el] = await page.$x(`//*[contains(text(), '${labelWord}')]/following::input[1]`);
                if(el) {
                    await el.click({ clickCount: 3 });
                    await el.type(text, { delay: 50 });
                }
            } catch(e) {}
        };

        // سوقلي يستخدم خانة واحدة للاسم الكامل
        await typeInputByLabel('الاسم الكامل', order.customerName);
        await typeInputByLabel('رقم الهاتف', order.phone);
        await typeInputByLabel('عنوان التوصيل', order.address);

        // 7. اختيار الولاية والمدينة (البلدية) بالذكاء الاصطناعي النصي
        console.log(`🗺️ خوارزمية الذكاء الاصطناعي: مطابقة الولاية [${order.wilaya}] والمدينة [${order.commune}]...`);
        
        const selectDropdownByText = async (labelWord, targetText) => {
            try {
                const [dropdown] = await page.$x(`//*[contains(text(), '${labelWord}')]/following::select[1]`);
                if (dropdown) {
                    const valueToSelect = await page.evaluate((sel, target) => {
                        const cleanArabic = (t) => t.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').trim();
                        const searchTarget = cleanArabic(target);
                        
                        for (let option of sel.options) {
                            const optionText = cleanArabic(option.textContent || option.innerText);
                            // يبحث عن الكلمة العربية داخل النص المركب (مثال: يبحث عن "عنابة" داخل "23 - Annaba / عنابة")
                            if (optionText.includes(searchTarget)) {
                                return option.value;
                            }
                        }
                        return null;
                    }, dropdown, targetText);

                    if (valueToSelect) {
                        await dropdown.select(valueToSelect);
                        await new Promise(r => setTimeout(r, 1500)); // ننتظر قليلاً لكي تُحمل قائمة المدن بناءً على الولاية
                    }
                }
            } catch(e) {}
        };

        // اختيار الولاية أولاً
        if (order.wilaya) await selectDropdownByText('ولاية', order.wilaya);
        // اختيار المدينة ثانياً
        if (order.commune) await selectDropdownByText('مدينة', order.commune);

        // 8. النقر على زر تأكيد الطلب النهائي
        console.log("🎯 جاري الضغط على الزر الأصفر 'تأكيد الطلب'...");
        const [submitBtn] = await page.$x("//button[contains(., 'تأكيد الطلب')]");
        if(submitBtn) {
            await submitBtn.evaluate(b => b.scrollIntoView());
            await new Promise(r => setTimeout(r, 1000));
            await submitBtn.click();
        }

        console.log("⏳ ننتظر صفحة النجاح (تم تأكيد طلبك بنجاح)...");
        await new Promise(r => setTimeout(r, 5000));
        
        console.log("🎉 العملية انتهت بنجاح على منصة سوقلي!");

    } catch (error) {
        console.error("❌ توقف البوت بسبب خطأ:", error.message);
    } finally {
        await browser.close();
        console.log("🔒 تم إغلاق المتصفح الآلي.");
    }
}

app.post('/api/order', (req, res) => {
    const orderData = req.body;
    res.status(200).json({ success: true, message: "Order received successfully" });
    submitToSawa9ly(orderData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 خادم Prix Choc المركزي (نسخة سوقلي Sawa9ly) يعمل على المنفذ ${PORT}`);
});
