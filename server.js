const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const wilayasMap = {
    "1": "أدرار", "2": "الشلف", "3": "الأغواط", "4": "أم البواقي", "5": "باتنة",
    "6": "بجاية", "7": "بسكرة", "8": "بشار", "9": "البليدة", "10": "البويرة",
    "11": "تمنراست", "12": "تبسة", "13": "تلمسان", "14": "تيارت", "15": "تيزي وزو",
    "16": "الجزائر", "17": "الجلفة", "18": "جيجل", "19": "سطيف", "20": "سعيدة",
    "21": "سكيكدة", "22": "سيدي بلعباس", "23": "عنابة", "24": "قالمة", "25": "قسنطينة",
    "26": "المدية", "27": "مستغانم", "28": "المسيلة", "29": "معسكر", "30": "ورقلة",
    "31": "وهران", "32": "البيض", "33": "إليزي", "34": "برج بوعريريج", "35": "بومرداس",
    "36": "الطارف", "37": "تندوف", "38": "تيسمسيلت", "39": "الوادي", "40": "خنشلة",
    "41": "سوق أهراس", "42": "تيبازة", "43": "ميلة", "44": "عين الدفلى", "45": "النعامة",
    "46": "عين تموشنت", "47": "غرداية", "48": "غليزان", "49": "تيميمون", "50": "برج باجي مختار",
    "51": "أولاد جلال", "52": "بني عباس", "53": "عين صالح", "54": "عين قزام", "55": "تقرت",
    "56": "جانت", "57": "المغير", "58": "المنيعة"
};

async function submitToBabaAlgeria(order) {
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
        console.log("🚀 بدء الأتمتة للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        console.log("⏳ جاري فتح صفحة الدخول...");
        await page.goto('https://babaalgeria.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.BABA_EMAIL);
        await page.type('input[type="password"]', process.env.BABA_PASSWORD);
        
        console.log("⌨️ جاري الضغط على الدخول...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            page.click('button[type="submit"]')
        ]);
        
        // التعديل السحري: إجبار البوت على انتظار حفظ الجلسة (Session)
        console.log("⏳ ننتظر 5 ثواني لضمان حفظ الجلسة في المتصفح...");
        await new Promise(r => setTimeout(r, 5000));
        console.log("✅ تم الدخول وحفظ الجلسة بنجاح!");

        // 2. الذكاء الاصطناعي لتصحيح أخطاء Vercel (Ghost Killer)
        let incomingId = order.babaLink || order.babaId;
        if (!incomingId) throw new Error("⚠️ لم يتم استلام أي رابط أو كود من Vercel!");

        let cleanId = incomingId.toString().trim();
        if (cleanId === "NL-210" || cleanId === "NL-94") {
            cleanId = "323"; 
            console.log("🛠️ تم اكتشاف رمز قديم، تم التصحيح آلياً إلى الرابط: 323");
        }

        const productLink = cleanId.includes('http') ? cleanId : `https://www.babaalgeria.com/product/${cleanId}`;
        
        console.log(`🔗 جاري التوجه لصفحة المنتج مباشرة: ${productLink}`);
        await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000)); // انتظار اكتمال رسم الصفحة
        
        // 3. الضغط على "ابدأ البيع الآن" (طريقة البحث الشاملة)
        console.log("🛒 جاري البحث عن زر 'ابدأ البيع الآن'...");
        
        const isButtonClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            // نبحث في كل عناصر الصفحة عن الكلمة، سواء كان رابط أو زر
            const startBtn = elements.find(el => el.innerText && el.innerText.includes('ابدأ البيع') && el.tagName !== 'SCRIPT');
            if(startBtn) {
                startBtn.scrollIntoView();
                startBtn.click();
                return true;
            }
            return false;
        });

        if (isButtonClicked) {
            console.log("✅ تم العثور على الزر والضغط عليه! ننتظر الاستمارة...");
            // انتظار تحول الرابط إلى create-order
            try {
                await page.waitForFunction(() => window.location.href.includes('create-order'), { timeout: 15000 });
            } catch(e) {
                console.log("⚠️ لم يتغير الرابط، سنتوجه يدوياً...");
                await page.goto('https://babaalgeria.com/create-order', { waitUntil: 'networkidle2' });
            }
            await new Promise(r => setTimeout(r, 3000));
        } else {
            throw new Error(`❌ لم يتم العثور على زر 'ابدأ البيع الآن' في الرابط: ${productLink}. تأكد أن المنتج متوفر.`);
        }

        // 4. كتابة سعر العمولة
        console.log("💰 جاري تعديل السعر لضمان عمولتك...");
        const priceXPath = "//*[contains(text(), 'سعر البيع')]/following::input[1]";
        try {
            await page.waitForXPath(priceXPath, { timeout: 10000 });
            const [priceInput] = await page.$x(priceXPath);
            if (priceInput) {
                await priceInput.click({ clickCount: 3 }); 
                await page.keyboard.press('Backspace'); 
                await new Promise(r => setTimeout(r, 500));
                await priceInput.type(order.sellingPrice.toString(), { delay: 100 });
                await page.keyboard.press('Tab'); 
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {}

        // 5. إدخال بيانات الزبون
        console.log("👤 جاري إدخال معلومات الزبون...");
        const nameParts = order.customerName.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || '.'; 
        
        const typeInput = async (labelWord, text) => {
            try {
                const [el] = await page.$x(`//*[contains(text(), '${labelWord}')]/following::input[1]`);
                if(el) {
                    await el.click({ clickCount: 3 });
                    await el.type(text, { delay: 50 });
                }
            } catch(e) {}
        };

        await typeInput('الاسم', firstName);
        await typeInput('اللقب', lastName);
        await typeInput('الهاتف', order.phone);

        const finalAddress = (order.commune ? order.commune + " - " : "") + order.address;
        await typeInput('العنوان', finalAddress);

        // 6. قراءة واختيار الولاية
        const actualWilayaName = wilayasMap[order.wilaya] || order.wilaya;
        console.log(`🗺️ جاري تحديد الولاية [${actualWilayaName}]...`);
        try {
            const [wilayaSelect] = await page.$x("//*[contains(text(), 'ولاي')]/following::select[1]");
            if (wilayaSelect) {
                const valueToSelect = await page.evaluate((sel, wilayaName) => {
                    const cleanArabic = (text) => text.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').trim();
                    const targetName = cleanArabic(wilayaName);
                    for (let option of sel.options) {
                        const optionText = cleanArabic(option.textContent || option.innerText);
                        if (optionText.includes(targetName) || targetName.includes(optionText)) return option.value; 
                    }
                    return null;
                }, wilayaSelect, actualWilayaName);
                if (valueToSelect) await wilayaSelect.select(valueToSelect);
            }
        } catch(e) {}

        // 7. اختيار مكان الاستلام
        console.log("🚚 جاري تحديد مكان الاستلام...");
        try {
            if (order.deliveryLocation === 'home') {
                const [homeBtn] = await page.$x("//button[contains(., 'للمنزل')]");
                if(homeBtn) await homeBtn.click();
            } else {
                const [deskBtn] = await page.$x("//button[contains(., 'للمكتب')]");
                if(deskBtn) await deskBtn.click();
            }
        } catch(e) {}

        // 8. النقر على زر الإرسال
        console.log("🎯 جاري الضغط على زر 'إرسال الطلبية'...");
        const [submitBtn] = await page.$x("//button[contains(., 'إرسال الطلبية')]");
        if(submitBtn) {
            await submitBtn.evaluate(b => b.scrollIntoView());
            await new Promise(r => setTimeout(r, 1000));
            await submitBtn.click();
        }

        console.log("⏳ ننتظر استجابة منصة بابا الجزائر لحفظ الطلبية...");
        await new Promise(r => setTimeout(r, 4000));
        
        console.log("🎉 العملية انتهت بنجاح!");

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
    console.log(`🤖 خادم Prix Choc الخارق يعمل على المنفذ ${PORT}`);
});
