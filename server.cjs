const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

async function submitToSawa9ly(order) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log("🚀 بدء أتمتة سوقلي للطلبية:", order.customerName);

        // 1. تسجيل الدخول
        console.log("⏳ جاري الدخول لحساب سوقلي...");
        await page.goto('https://sawa9ly.app/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.SAWA9LY_EMAIL);
        await page.type('input[type="password"]', process.env.SAWA9LY_PASSWORD);
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            page.click('button[type="submit"]')
        ]);
        await new Promise(r => setTimeout(r, 5000));
        
        // 2. التوجه للمنتج
        if (!order.sawa9lyLink) throw new Error("⚠️ لم يتم استلام الرابط!");
        await page.goto(order.sawa9lyLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000)); 
        
        // 3. الضغط على قدم طلبك
        console.log("🛒 جاري فتح الاستمارة...");
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const orderBtn = elements.find(el => el.innerText && el.innerText.includes('قدم طلبك') && el.tagName !== 'SCRIPT');
            if(orderBtn) orderBtn.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // 4. تعديل الكمية والسعر
        console.log(`💰 تعديل السعر إلى ${order.sellingPrice} والكمية إلى ${order.quantity || 1}...`);
        
        if (order.quantity && order.quantity > 1) {
            try {
                const [plusBtn] = await page.$x("//button[contains(text(), '+')]");
                if (plusBtn) {
                    for(let i = 1; i < order.quantity; i++) {
                        await plusBtn.click();
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            } catch (e) { console.log("⚠️ لم يتمكن من تعديل الكمية."); }
        }

        const priceInputXPath = "//input[@type='number' or contains(@class, 'price')]"; 
        try {
            await page.waitForXPath(priceInputXPath, { timeout: 10000 });
            const [priceInput] = await page.$x(priceInputXPath);
            if (priceInput) {
                await priceInput.click({ clickCount: 3 }); 
                await page.keyboard.press('Backspace'); 
                await new Promise(r => setTimeout(r, 500));
                await priceInput.type(order.sellingPrice.toString(), { delay: 100 });
                await page.keyboard.press('Tab'); 
                
                await page.evaluate(el => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, priceInput);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {}

        // 5. استمرار
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const continueBtn = elements.find(el => el.innerText && el.innerText.includes('استمرار') && el.tagName !== 'SCRIPT');
            if(continueBtn) continueBtn.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // 6. بيانات الزبون
        console.log("👤 إدخال بيانات الزبون...");
        const typeReactInput = async (labelText, text) => {
            try {
                const [el] = await page.$x(`//*[contains(text(), '${labelText}')]/following::input[1]`);
                if(el) {
                    await el.click({ clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await el.type(text, { delay: 50 });
                    await page.evaluate(node => {
                        node.dispatchEvent(new Event('input', { bubbles: true }));
                        node.dispatchEvent(new Event('change', { bubbles: true }));
                    }, el);
                }
            } catch(e) {}
        };
        await typeReactInput('الاسم الكامل', order.customerName);
        await typeReactInput('رقم الهاتف', order.phone);
        await typeReactInput('عنوان التوصيل', order.address);

        // 7. الولاية والمدينة (الحل الجذري)
        const selectReactDropdown = async (labelText, targetText) => {
            try {
                const [dropdown] = await page.$x(`//*[contains(text(), '${labelText}')]/following::select[1]`);
                if (dropdown) {
                    const valueToSelect = await page.evaluate((sel, target) => {
                        const clean = (t) => t.replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').toLowerCase().trim();
                        const searchTarget = clean(target);
                        for (let option of sel.options) {
                            if (clean(option.textContent).includes(searchTarget) || searchTarget.includes(clean(option.textContent))) return option.value;
                        }
                        return null;
                    }, dropdown, targetText);

                    if (valueToSelect) {
                        await page.evaluate((sel, val) => {
                            sel.value = val;
                            sel.dispatchEvent(new Event('change', { bubbles: true }));
                            sel.dispatchEvent(new Event('input', { bubbles: true }));
                        }, dropdown, valueToSelect);
                        console.log(`✅ تم اختيار: ${targetText}`);
                        await new Promise(r => setTimeout(r, 3000)); 
                    }
                }
            } catch(e) {}
        };

        console.log(`🗺️ جاري اختيار الولاية والبلدية...`);
        if (order.wilaya) await selectReactDropdown('ولاية', order.wilaya);
        if (order.commune) await selectReactDropdown('مدينة', order.commune);

        // 8. تأكيد الطلب
        console.log("🎯 جاري الضغط على 'تأكيد الطلب'...");
        const [submitBtn] = await page.$x("//button[contains(., 'تأكيد الطلب') or contains(., 'تأكيد')]");
        if(submitBtn) {
            await submitBtn.evaluate(b => b.scrollIntoView({block: 'center'}));
            await new Promise(r => setTimeout(r, 1000));
            await submitBtn.click();
        }

        // 9. التحقق الصارم
        console.log("⏳ ننتظر رسالة التأكيد من سوقلي...");
        try {
            await page.waitForXPath("//*[contains(text(), 'نجاح') or contains(text(), 'تأكيد طلبك')]", { timeout: 15000 });
            console.log("🎉 العملية انتهت بنجاح 100% وتم تسجيل الطلب في لوحة تحكم سوقلي!");
        } catch(e) {
            throw new Error("❌ لم تظهر صفحة النجاح، يرجى مراجعة الطلبية في سوقلي يدوياً.");
        }

    } catch (error) {
        console.error("❌ توقف البوت بسبب خطأ:", error.message);
    } finally {
        await browser.close();
    }
}

app.post('/api/order', (req, res) => {
    res.status(200).json({ success: true });
    submitToSawa9ly(req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🤖 يعمل على ${PORT}`); });
