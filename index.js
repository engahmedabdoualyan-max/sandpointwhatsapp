import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USERS_FILE = join(__dirname, 'users.json');

// Track recently processed message IDs to prevent duplicates
const processedMessageIds = new Set();
const MESSAGE_DEDUPE_TIMEOUT = 60000; // 1 minute

// Sanitize Eastern Arabic numerals (١٢٣٤٥٦٧٨٩٠) to Western (1234567890)
function sanitizeArabicNumerals(text) {
  const arabicMap = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
  };
  return text.replace(/[٠-٩۰-۹]/g, char => arabicMap[char] || char);
}

// Validate Saudi phone number: exactly 10 digits starting with 05, or international format
function validateSaudiPhone(phone) {
  const cleaned = sanitizeArabicNumerals(phone.replace(/[\s-]/g, ''));
  if (/^05[0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^\+9665[0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^9665[0-9]{8}$/.test(cleaned)) return '+' + cleaned;
  return null;
}

// Check if message ID was already processed recently
function isDuplicate(id) {
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.add(id);
  setTimeout(() => processedMessageIds.delete(id), MESSAGE_DEDUPE_TIMEOUT);
  return false;
}

let usersData = {};

function loadUsers() {
  if (existsSync(USERS_FILE)) {
    try {
      usersData = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
    } catch (e) {
      usersData = {};
    }
  } else {
    usersData = {};
  }
}

function saveUsers() {
  writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf-8');
}

function getUserState(userId) {
  if (!usersData[userId]) {
    usersData[userId] = {
      step: 'language',
      language: null,
      category: null,
      profession: null,
      collect_step: 0,
      name: '',
      phone: '',
      specialty: '',
      details: '',
      files: [],
      first_contact: true
    };
    saveUsers();
  }
  return usersData[userId];
}

function updateUserState(userId, updates) {
  usersData[userId] = { ...usersData[userId], ...updates };
  saveUsers();
}

const SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;

const SHEET_CATEGORY_LABELS = {
  '1': 'عميل جديد / New Client',
  '2': 'شركة / Company',
  '3': 'باحث عن عمل / Job Seeker'
};

const SHEET_PROFESSION_LABELS = {
  engineer: 'مهندس / Engineer',
  technician: 'تقني / Technician',
  worker: 'عامل / Worker'
};

const SHEET_LANGUAGE_LABELS = {
  ar: 'العربية', en: 'English', ur: 'اردو', ne: 'नेपाली', bn: 'বাংলা', hi: 'हिन्दी', tl: 'Filipino'
};

async function saveRegistrationToSheet(userId, userState) {
  if (!SHEET_WEBHOOK_URL) {
    console.log('⚠️ GOOGLE_SHEET_WEBHOOK_URL not set - skipping sheet save');
    return;
  }
  const payload = {
    timestamp: new Date().toLocaleString(),
    wa_number: userId,
    language: SHEET_LANGUAGE_LABELS[userState.language] || userState.language || '',
    category: SHEET_CATEGORY_LABELS[userState.category] || userState.category || '',
    profession: SHEET_PROFESSION_LABELS[userState.profession] || userState.profession || '',
    name: userState.name || '',
    phone: userState.phone || '',
    details: userState.details || userState.specialty || '',
    files_count: (userState.files || []).length
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const result = await res.text();
    console.log(`📊 Google Sheet save: HTTP ${res.status} - ${result.slice(0, 200)}`);
  } catch (err) {
    console.log('⚠️ Google Sheet save failed:', err.message);
  }
}

function resetUserState(userId) {
  usersData[userId] = {
    step: 'language',
    language: null,
    category: null,
    profession: null,
    collect_step: 0,
    name: '',
    phone: '',
    specialty: '',
    details: '',
    files: [],
    first_contact: true
  };
  saveUsers();
}

async function humanDelay() {
  const delay = Math.floor(Math.random() * 2000) + 3000;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Ensure NO promise hangs forever - the #1 reason the bot "tries but can't reply"
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: ' + label + ' (' + ms + 'ms)')), ms))
  ]);
}

async function safePresence(sock, jid) {
  try {
    await withTimeout(sock.sendPresenceUpdate('composing', jid), 5000, 'presence');
  } catch (e) {}
}

// Track message IDs for de-duplication in the listener

async function sendHumanLikeMessage(sock, userId, message, options = {}) {
  await safePresence(sock, userId);
  await humanDelay();
  await sendWithRetry(sock, userId, { text: message, ...options });
}

async function sendImageMessage(sock, userId, imagePath, caption = '') {
  await safePresence(sock, userId);
  await humanDelay();
  if (!existsSync(imagePath)) {
    await sendWithRetry(sock, userId, { text: caption });
    return;
  }
  const imageBuffer = readFileSync(imagePath);
  await sendWithRetry(sock, userId, { image: imageBuffer, caption });
}

async function sendDocumentMessage(sock, userId, docPath, fileName, caption = '') {
  await safePresence(sock, userId);
  await humanDelay();
  if (!existsSync(docPath)) {
    await sendWithRetry(sock, userId, { text: caption || '📎 تواصل مع الدعم للحصول على الملف' });
    return;
  }
  const docBuffer = readFileSync(docPath);
  await sendWithRetry(sock, userId, { document: docBuffer, fileName });
}

const LANG_MESSAGES = {
  ar: {
    greeting: `مرحباً بكم في شركة ساند بوينت للمقاولات (SAND POINT GLOBAL) - الدمام
نحن شركة مقاولات رائدة في المنطقة الشرقية، ونقدم خدماتنا بأعلى معايير الجودة.
يرجى اختيار الخدمة المطلوبة من القائمة:
📝 اكتب الرقم أو اختر من القائمة...`,
    options: {
      1: `عميل جديد - نرحب بكم! عشان نتعرف على مشروعك، نحتاج:
• نوع العقار (سكني، تجاري، صناعي، إلخ)
• نوع الأعمال (بناء، تشطيب، صيانة)
• مساحة العقار بالمتر المربع
• الحي / المنطقة في الدمام
📝 ابدأ بـ **اسمك**... 
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      2: `مقاول/مورد - نرحب بك في شبكة شركائنا! عشان نرفع ملفك لقسم المشاريع ونتعامل معك بجدية، نحتاج:
• الملف التجاري (PDF أو صورة)
• اسمك/اسم الشركة
• مجال تخصصك (بناء، كهرباء، سباكة، تكييف، إلخ)
• رقم الجوال
📝 ابدأ بـ **اسمك/اسم الشركة**...
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      3: `باحث عن عمل - نقدر اهتمامك بفريقنا! حياك الله. عشان نعرف موقعك تحديداً، قولنا: **ماهي مهنتك؟** (مهندس أم مهندسة، تقني، أم عامل؟)
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      4: `🏢 **ملف شركة ساند بوينت للمقاولات (SAND POINT GLOBAL)**:
شركة سعودية رائدة في قطاع المقاولات والبنية التحتية، مقرها في الدمام - المنطقة الشرقية.

🏗️ **مجالات عملنا**:
• المقاولات العامة والمباني السكنية والتجارية
• البنية التحتية والطرق
• المحطات الكهربائية والميكانيكية
• محطات معالجة المياه والصرف
• الصيانة والتشغيل للمنشآت الحكومية والخاصة

📜 **التصنيفات**:
• تصنيف وزارة الشؤون البلدية والقروية
• شهادة الأيزو 9001، 14001، 45001
• عضوية الغرف السعودية

🏆 **مشاريعنا**:
• أمانة المنطقة الشرقية
• شركة أرامكو
• الهيئة الملكية
• وزارة التعليم

📝 اكتب **9** للعودة للقائمة الرئيسية
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      5: `📍 **بيانات التواصل - شركة ساند بوينت للمقاولات**:

📍 العنوان: الدمام - المنطقة الشرقية - المملكة العربية السعودية
📞 الهاتف: +966 543120557
📱 واتساب: +966 543120557
📧 البريد الإلكتروني: info@sandpointglobal.com
🌐 الموقع الإلكتروني: www.sandpointglobal.com

⏰ ساعات العمل:
السبت - الخميس: 7:30 ص - 3:30 م | الجمعة: مغلق

📝 اكتب **9** للعودة للقائمة الرئيسية
0️⃣ للرجوع وتغيير اللغة / Go Back`,
    },
    prompts: {
      name: 'الاسم الكامل',
      phone: 'رقم الجوال',
      specialty: 'مجال التخصص',
      details: 'التفاصيل',
      profession: 'مهنتك',
      property_type: 'نوع العقار',
      work_type: 'نوع الأعمال (بناء، تشطيب، صيانة)',
      area: 'مساحة العقار بالمتر المربع',
      district: 'الحي / المنطقة في الدمام',
      cv_files: 'ملف السيرة الذاتية (PDF)',
      work_files: 'صور أو فيديوهات من أعمال سابقة',
      company_profile: 'الملف التجاري (PDF أو صورة)',
      invalid_phone: '❌ رقم الجوال غير صحيح. الحين اكتب رقم سعودي صحيح مثل: 05XXXXXXXX أو +9665XXXXXXXX:',
      invalid_name: '❌ الاسم قصير جداً. الحين اكتب اسمك الكامل:',
      invalid_profession: '❌ يرجى تحديد مهنتك بدقة: مهندس، تقني، أم عامل؟',
      thank_you: 'حياك الله! تواصلك مع فريقنا تم استلامه. بنراجع طلبك ونتواصل معاك قريب. 🌟',
      engineer_prompt: '✅ عشان يتم فرز طلبك والتواصل مع القسم المناسب، يرجى إرفاق السيرة الذاتية (PDF) الآن. أو اكتب **تم** للمتابعة بدون ملف.',
      worker_prompt: '✅ عشان نطلع على خبرتك ومهاراتك، يرجى إرفاق صور أو فيديوهات من أعمال سابقة. أو اكتب **تم** للمتابعة.'
    },
    summary: '✅ تم استلام طلبك بنجاح!\n📋 البيانات المسجلة:\n• الاسم: {name}\n• الجوال: {phone}\n• التفاصيل: {details}\n\n📞 هاتفنا: +966 543120557\n🕐 بنتواصل معاك خلال 24 ساعة إن شاء الله.\nشكراً لوثوقك بشركة ساند بوينت للمقاولات 🌟\n\n📝 اكتب **9** للعودة للقائمة الرئيسية\n0️⃣ للرجوع وتغيير اللغة / Go Back',
    menuTitle: '📋 قائمة الخدمات - شركة ساند بوينت للمقاولات',
    menuOptions: [
      {
        title: 'خدماتنا',
        rows: [
          { title: '1️⃣ عميل جديد', description: 'طلب عرض سعر أو استفسار' },
          { title: '2️⃣ مقاول/مورد', description: 'التعاون مع شركة ساند بوينت' },
          { title: '3️⃣ باحث عن عمل', description: 'الانضمام إلى فريقنا' },
          { title: '4️⃣ ملف الشركة', description: 'معرفة المزيد عنا' },
          { title: '5️⃣ بيانات التواصل', description: 'أرقامنا وساعات العمل' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 اختر لغة التواصل',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'اللهجة السعودية' },
          { title: '🇬🇧 English', description: 'English language' },
          { title: '🇵🇰 اردو (Urdu)', description: 'اردو زبان' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'বাংলা ভাষা' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिंदी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  en: {
    greeting: `Welcome to Sand Point Contracting (SAND POINT GLOBAL) - Dammam 🏗️
We are a leading Saudi contracting company serving the Eastern Province with top-quality construction services!
Please choose the service you need from the menu below:
📝 Enter the option number...`,
    options: {
      1: `New Client - We're happy to assist you!
To provide you with the best service, we need:
• Property type (residential, commercial, industrial, etc.)
• Type of Work (new construction, renovation, maintenance)
• Property area in square meters
• District/neighborhood in Dammam
📝 Start with **your name**...
0️⃣ Go Back / تغيير اللغة`,
      2: `Subcontractor - Welcome to our partner network!
To register your company profile and work with us properly:
• Company profile (PDF or image)
• Your/company name
• Your specialization (Construction, Electrical, Plumbing, AC, etc.)
• Mobile number
📝 Start with **your/company name**...
0️⃣ Go Back / تغيير اللغة`,
      3: `Job Seeker - Thank you for your interest in joining us!
To route your application correctly, please tell us: **What is your profession?** (Engineer, Technician, or Worker)?
0️⃣ Go Back / تغيير اللغة`,
      4: `🏢 **Company Profile - Sand Point Contracting (SAND POINT GLOBAL)**:
A leading Saudi company in contracting and infrastructure, headquartered in Dammam, Eastern Province.

🏗️ **Our Sectors**:
• General contracting, residential & commercial buildings
• Infrastructure & roads
• Electrical & mechanical stations
• Water treatment & sewage plants
• Maintenance & operation of government & private facilities

📜 **Certifications**:
• Classification from Ministry of Municipal & Rural Affairs
• ISO 9001, 14001, 45001 certifications
• Saudi Chambers membership

🏆 **Our Projects**:
• Eastern Province Municipality
• Saudi Aramco
• Royal Commission
• Ministry of Education

📝 Enter **9** for main menu
0️⃣ Go Back / تغيير اللغة`,
      5: `📍 **Contact Information - Sand Point Contracting**:

📍 Address: Dammam - Eastern Province - Saudi Arabia
📞 Phone: +966 543120557
📱 WhatsApp: +966 543120557
📧 Email: info@sandpointglobal.com
🌐 Website: www.sandpointglobal.com

⏰ Working Hours:
Saturday - Thursday: 7:30 AM - 3:30 PM | Friday: Closed

📝 Enter **9** for main menu
0️⃣ Go Back / تغيير اللغة`,
    },
    prompts: {
      name: 'Full Name',
      phone: 'Mobile Number',
      specialty: 'Specialization',
      details: 'Details',
      profession: 'Your Profession',
      property_type: 'Property Type',
      work_type: 'Type of Work (new construction, renovation, maintenance)',
      area: 'Property Area (sqm)',
      district: 'District/Neighborhood in Dammam',
      cv_files: 'CV File (PDF)',
      work_files: 'Work Photos/Videos',
      company_profile: 'Company Profile (PDF or image)',
      invalid_phone: '❌ Invalid mobile number. Please enter a valid Saudi number (e.g., 05XXXXXXXX or +9665XXXXXXXX):',
      invalid_name: '❌ Name too short. Please enter your full name:',
      invalid_profession: '❌ Please specify your profession: Engineer, Technician, or Worker?',
      thank_you: 'Thank you for reaching out to our team! We have received your message and will get back to you shortly. 🌟',
      engineer_prompt: '✅ Your application will be reviewed by our engineering department. Please attach your CV (PDF). Or type **done** to proceed without a file.',
      worker_prompt: '✅ In order to assess your skills properly, please attach photos or videos of your previous work. Or type **done** to proceed without files.'
    },
    summary: '✅ Your request has been received successfully!\n📋 Registered details:\n• Name: {name}\n• Mobile: {phone}\n• Details: {details}\n\n📞 Our phone: +966 543120557\n🕐 We will contact you within 24 hours.\nThank you for trusting Sand Point Contracting 🌟\n\n📝 Enter **9** for main menu\n0️⃣ Go Back / تغيير اللغة',
    menuTitle: '📋 Service Menu - Sand Point Contracting',
    menuOptions: [
      {
        title: 'Our Services',
        rows: [
          { title: '1️⃣ New Client', description: 'Request a quote or inquiry' },
          { title: '2️⃣ Subcontractor', description: 'Partner with Sand Point' },
          { title: '3️⃣ Job Seeker', description: 'Join our team' },
          { title: '4️⃣ Company Profile', description: 'Learn more about us' },
          { title: '5️⃣ Contact Info', description: 'Our address and working hours' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 Choose your language',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'Saudi dialect' },
          { title: '🇬🇧 English', description: 'English language' },
          { title: '🇵🇰 اردو (Urdu)', description: 'اردو زبان' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'বাংলা ভাষা' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिंदी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  ur: {
    greeting: `سینڈ پوائنٹ گلوبل کانٹریکٹنگ (SAND POINT GLOBAL) - جلیل میں سواگت ہے 🏗️
ہم ایک سعودی کنٹریکٹر ہیں جو مشرقی علاقائی کی تعمیر کی کوشش کرتے ہیں!
براہ کرم مندرجہ ذیل سروسز میں سے ایک منتخب کریں:
📝 نمبر لکھیں...`,
    options: {
      1: `نیو کلائنٹ - ہم آپ کی خدمت کرنا چاہتے ہیں!
بہترین سروس کے لیے ہم ضرورت رکھتے ہیں:
• پراپرٹی کی قسم (ریزیڈینشل، کامرشل، انڈسٹریشل، وغیرہ)
• کام کی قسم (نیا ازائدہ، دوبارہ تعمیر، رکف صیانت)
• پراپرٹی کریویچر مربع میٹر میں
• ڈسٹرکٹ/پڑوس میں
📝 **اپنا نام** لکھیں...`,
      2: `سب کونٹراکٹر - ہمارے ساتھ شراکت کے نیٹ ورک میں خوش آمدید!
اپنا کمپنی پروفائل رجسٹر کرنا اور ہم سے ملنا ہے تو:
• کمپنی پروفائل (PDF یا تصویر)
• آپ کا/کمپنی کا نام
• آپ کی تخصص (کنکریشن، الیکٹریکل، پلامبر، ایسی اے سی، وغیرہ)
• موبائل نمبر
📝 **آپ کا/کمپنی کا نام** لکھیں...
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      3: `جاب سیکر - ہماری ٹیم میں شامل ہونے کے لئے آپ کے دلچسپی کے لئے شکریہ!
آپ کی درخواست کو درست انداز میں رواج کے لئے مہینے کریں: **آپ کی پیشہ وری کیا ہے؟** (اینجینئر، ٹیکنیشین، یا کارگر؟)
0️⃣ للرجوع وتغيير اللغة / Go Back`,
      4: `🏢 **کمپنی پروفائل - سینڈ پوائنٹ گلوبل**:
سعودی عرب کی ایک اگرو معاشرے کی کمپنی، الخلیج میں مرکزی دفتر

🏗️ **ہمارے سیکٹر**:
• جنرل کنٹریکٹنگ، ریزیڈینشل اینڈ کامرشل بلڈنگز
• انفراسٹرکچر اینڈ راستے
• الیکٹریکل اینڈ میکانیکل اسٹیشن
• پانی کی صفائی اور سیویج پلانٹس
• حکومتی اور نجی سہولتوں کی رکف سینٹینینس ایڈ ان آپریشن

📜 **سرٹیفیکیشن**:
• مناسب منصوبے وزارت سے درج
• آئی ایس او 9001، 14001، 45001
• سعودی چیمبرز کے اراکین

🏆 **ہمارے منصوبے**:
• مشرقی علاقائی کی سوزائی
• سعودی عرامکو
• راجی ہیکامیشن
• تعلیم وزارت

📝 مرکزی مینو کے لیے **9** لکھیں یا سیمیل رابطے کیلئے **0** لکھیں...`,
      5: `📍 **رابطہ معلومات - سینڈ پوائنٹ گلوبل**:

📍 پتہ: الخلیج - مشرقی علاقہ - سعودی عرب
📞 فون: +966 543120557
📱 واٹس ایپ: +966 543120557
📧 ای میل: info@sandpointglobal.com
🌐 ویب سائیٹ: www.sandpointglobal.com

⏰ کام کے اوقات:
اتوار - ہفتہ 7:30 صبح - 3:30 بجرے دوپہر
ہفتہ - شنی وار: بند

📝 مرکزی مینو کے لیے **9** لکھیں یا سیمیل رابطے کیلئے **0** لکچیں...`
    },
    prompts: {
      name: 'مکمل نام',
      phone: 'موبائل نمبر',
      specialty: 'تخصص',
      details: 'تفصیلات',
      profession: 'آپ کی پیشہ وری',
      property_type: 'پراپرٹی کی قسم',
      work_type: 'کام کی قسم (تعمیر, ترمیم, رکف صیانت)',
      area: 'کشتی (سکوایر میٹر)',
      district: 'ڈسٹرکٹ/مقام قرآت میں',
      cv_files: 'سی وی فائل (PDF)',
      work_files: 'کام کی تصاویر/ویڈیو',
      company_profile: 'کمپنی پروفائل (PDF یا تصویر)',
      invalid_phone: '❌ غلط فون نمبر۔ براہ کرم ایک درست سعوی نمبر لکھیں (جیسے: 05XXXXXXXX یا +9665XXXXXXXX):',
      invalid_name: '❌ نام بہت مختصر ہے۔ براہ کرم اپنا مکمل نام لکھیں:',
      invalid_profession: '❌ براہ کرم اپنی پیشہ وری واضح بنائیں: انجینئر، ٹیکنیشین، یا مجرور؟',
      thank_you: 'ہماری ٹیم سے رابطے کو شکریہ! ہم نے آپ کے پیغام کو موصول کیا ہے اور ہم جلد از جلد واپس آئیں گے۔ 🌟',
      engineer_prompt: '✅ آپ کی درخواست ہمارے انجینئری واحد کے لیے موصول ہوگئی۔ براہ کرم اپنا CV (PDF) ایٹیچ کریں۔ یا بغیر فائل کے آگے بڑھنے کے لئے **تم** لکھیں۔',
      worker_prompt: '✅ آپ کی صلاحیت کے لئے براہ کرم اپنے پچھلے کام کی تصاویر یا ویڈیو ایڈیٹ کریں۔ یا بغیر فائل کے آگے بڑھنے کے لئے **تم** لکھیں۔'
    },
    summary: `✅ آپ کا درخواست برائے موصول!\n📋 درج شدہ تفصیلات:\n• نام: {name}\n• موبائل: {phone}\n• تفصیلات: {details}\n\n📞 ہمارا فون: +966 543120557\n🕐 ہم 24 گھنٹے کے اندر آپ سے رابطے کریں گے۔\nسینڈ پوائنٹ گلوبل پر بھروسے کے لئے شکریہ 🌟\n\n📝 مرکزی مینو کے لیے **9** لکھیں یا سیمیل رابطے کیلئے **0** لکچیں...`,
    menuTitle: '📋 سروسز کی مینو - سینڈ پوائنٹ گلوبل',
    menuOptions: [
      {
        title: 'ہماری سروسز',
        rows: [
          { title: '1️⃣ نیو کلائنٹ', description: 'کوٹ کی درخواست یا استفسار' },
          { title: '2️⃣ سب کونٹراکٹر', description: 'سینڈ پوائنٹ کے ساتھ شراکت' },
          { title: '3️⃣ جاب سیکر', description: 'ہماری ٹیم میں شامل ہوں' },
          { title: '4️⃣ کمپنی پروفائل', description: 'ہمارے بارے میں مزید جانیں' },
          { title: '5️⃣ رابطہ معلومات', description: 'ہمارا پتہ، فون اور کام کے اوقات' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 اپنا زبان منتخب کریں',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'ساؤڈی ڈیئلیکٹ' },
          { title: '🇬🇧 English', description: 'انگریزی زبان' },
          { title: '🇵🇰 اردو (Urdu)', description: 'اردو زبان' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'বাংলা ভাষা' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिंदी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  ne: {
    greeting: `स्यान्ड पोइंट ग्लोबल कन्ट्राक्टिङ (SAND POINT GLOBAL) - दम्मममा स्वागत छ 🏗️
हामी पूर्वी प्रांवमा एक अग्रणी सउदी निर्माण कम्पनी छौं!
कृपया तलबाट सेवा छनोट गर्नुहोस्:`,
    options: {
      1: `नयाँ ग्राहक - हामी तपाईंको सेवा गर्न खुश हुनुहुन्छ!
सर्वोत्तम सेवा प्रदान गर्न हामी आवश्यक छ:
• सम्पत्ति को प्रकार (बासिन्दा, व्यावसायिक, औद्योगिक आदि)
• कामको प्रकार (नयाँ निर्माण, रीनोभेशन, मर्मत)
• सम्पत्ति क्षेत्रफल वर्ग मिटरमा
• दम्ममको डिस्ट्रिक्ट/पड़ोस
📝 **आफ्नो नाम** लेख्नुहोस्...
0️⃣ लेख्नुहोस् / Go Back`,
      2: `सबकन्ट्राक्टर - हाम्रो साझेदारी नेटवर्कमा स्वागत छ!
कम्पनीको प्रोफाइल दर्ता गर्न र हामीलाई कसरी काम गर्न चाहनुहुन्छ:
• कम्पनी प्रोफाइल (PDF वा चित्र)
• तपाईंको/कम्पनीको नाम
• तपाईंको विशेषज्ञता (निर्माण, बिद्युत, प्लम्बिङ, एसी, अन्य)
• मोबाइल नम्बर
📝 **तपाईंको/कम्पनीको नाम** लेख्नुहोस्...
0️⃣ ललेगा / Go Back`,
      3: `रोजगारीको खोजी - हाम्रो टोलीमा जोडिन चाहनुभएकोमा धन्यवाद!
तपाईंको आवेदनलाई सही रूपमा मार्गित गर्न, हामीलाई बताउनुहोस्: **तपाईंको पेशा के हो?** (इन्जिनियर, टेक्निशियन, वा मजदुर)?
0️⃣ ललेगا / Go Back`,
      4: `🏢 **कम्पनी प्रोफाइल - स्यान्ड पोइंट ग्लोबल कन्ट्राक्टिङ**:
सउदी अरबको पूर्वी प्रांव, दम्मममा अवस्थित अग्रणी निर्माण कम्पनी

🏗️ **हामी काम गर्ने ठाउ**:
• सामान्य निर्माण, बासिन्दा र व्यावसायिक इमारतहरू
• पूर्वाधार र सडक
• विद्युत र यान्त्रिक स्टेशन
• पानीको शोधन र अपशिष्ट
• सरकारी र निजी सुविधाको रखरखाव र संचालन

📜 **प्रमाणपत्र**:
• स्थानीय विकास मन्त्रालयको वर्गीकरण
• ISO 9001, 14001, 45001
• सउदी च्याम्बर्स सदस्यता

🏆 **हामीको प्रोजेक्टहरू**:
• पूर्वी प्रांव म्युनिसिपालिटी
• सउदी अरामको
• राजा आयोजना
• शिक्षा मन्त्रालय

📝 मुख्य मेनुमा फर्कन **9** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`,
      5: `📍 **सम्पर्क जानकारी - स्यान्ड पोइंट ग्लोबल**:

📍 ठेगाना: दम्मम - पूर्वी प्रांव - सउदी अरब
📞 फोन: +966 543120557
📱 व्हाट्सऐप: +966 543120557
📧 ईमेल: info@sandpointglobal.com
🌐 वेबसाइट: www.sandpointglobal.com

⏰ कामको समय:
आइतवार - बिहीबार 7:30 बिही - 3:30 बिही
शुक्र - शनि: बन्द

📝 मुख्य मेनुमा फर्कन **9** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`
    },
    prompts: {
      name: 'पूरा नाम',
      phone: 'मोबाइल नम्बर',
      specialty: 'विशेषज्ञता क्षेत्र',
      details: 'विवरण',
      profession: 'तपाईंको पेशा',
      property_type: 'सम्पत्ति को प्रकार',
      work_type: 'कामको प्रकार (नयाँ निर्माण, ढाँचा, मर्मत सम्भार)',
      area: 'क्षेत्रफल (वर्ग मिटर)',
      district: 'डिस्ट्रिक्ट/पड्डोस दम्मममा',
      cv_files: 'सिभी फाइल (PDF)',
      work_files: 'कामका फोटो/भिडियो',
      company_profile: 'कम्पनी प्रोफाइल (PDF वा चित्र)',
      invalid_phone: '❌ अमान्य फोन नम्बर। एक वैध सउदी नम्बर लिख्नुहोस् (जस्तै: 05XXXXXXXX वा +9665XXXXXXXX):',
      invalid_name: '❌ नाम धेरै छोटो छ। आफ्नो पूरा नाम लिख्नुहोस्:',
      invalid_profession: '❌ एक वैध पेशा चुन्नुहोस्: इन्जिनियर, टेक्निशियन, वा मजदुर।',
      thank_you: 'स्यान्ड पोइंट ग्लोबललाई सम्पर्क गर्नुभएकोमा धन्यवाद। हामीले तपाईंको सन्देश प्राप्त गरेका छौं र अर्को समयमा फर्किनेछौं। 🌟',
      engineer_prompt: '✅ तपाईंको आवेदन हाम्रो इन्जिनियरिङ विभागमा पुग्नेछ। कृपया आफ्नो CV (PDF) संलग्न गर्नुहोस्। वा फाइल बिना अगाडि बढ्न **done** लेख्नुहोस्।',
      worker_prompt: '✅ तपाईंको क्षमता मूल्यांकन गर्न हामीलाई तपाईंको अघिल्लो कामका फोटो वा भिडियो चाहिए। वा फाइल बिना अगाडि बढ्न **done** लेख्नुहोस्।'
    },
    summary: `✅ तपाईंको अनुरोध सफलतापूर्वक प्राप्त भयो!\n📋 दर्ता विवरण:\n• नाम: {name}\n• मोबाइल: {phone}\n• विवरण: {details}\n\n📞 हाम्रो फोन: +966 543120557\n🕐 हामीले 24 घण्टाभित्र तपाईंसँग सम्पर्क गर्नेछौं।\nस्यान्ड पोइंट ग्लोबलमा विश्वास गर्नुभएकोमा धन्यवाद 🌟\n\n📝 मुख्य मेनुमा फर्कन **9** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`,
    menuTitle: '📋 सेवा मेनु - स्यान्ड पोइंट ग्लोबल',
    menuOptions: [
      {
        title: 'हामीको सेवाहरू',
        rows: [
          { title: '1️⃣ नयाँ ग्राहक', description: 'मूल्य अनुमान वा प्रश्न' },
          { title: '2️⃣ सबकन्ट्राक्टर', description: 'स्यान्ड पोइंटको साथ साझेदारी' },
          { title: '3️⃣ रोजगारीको खोजी', description: 'हामी टोलीमा जोड्नुहोस्' },
          { title: '4️⃣ कम्पनी प्रोफाइल', description: 'हामीबारे थप जान्नुहोस्' },
          { title: '5️⃣ सम्पर्क जानकारी', description: 'हाम्रो ठेगाना र कामको समय' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 तपाईंको भाषा छान्नुहोस्',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'साउदी डिऐलेक्ट' },
          { title: '🇬🇧 English', description: 'इंग्लिश भाषा' },
          { title: '🇵🇰 اردو (Urdu)', description: 'उर्दु भाषा' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'बंग्ला भाषा' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिन्दी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'ट्यागालग भाषा' }
        ]
      }
    ]
  },
  bn: {
    greeting: `স্যান্ড পয়েন্ট গ্লোবাল কন্ট্রাক্টিং (SAND POINT GLOBAL) - ঢাকামে স্বাগতম 🏗️
আমরা পূর্বীয় প্রান্তে একটি অগ্রণী সৌদি ঠিঠিকল কোম্পানি।
নিচের সেবাগুলি থেকে একটি বাছাই করুন:`,
    options: {
      1: `নতুন গ্রাহক - আমরা আপনার সেবা করতে আনন্দিত!
সর্বোত্তম সেবা প্রদানের জন্য আমরা প্রয়োজন:
• সম্পত্তির ধরন (বাসস্থান, বাণিজ্যিক, ঔদ্যোগিক ইত্যাদি)
• কর্মের ধরন (নতুন নির্মাণ, রীনভেশন, রক্ষণাবেক্ষণ)
• সম্পত্তির ক্ষেত্রফল বর্গ মিটারে
• গাঢ়াম (ঢাকাম) এর জেলা/পড়োস
📝 **আপনার নাম** লিখে শুরু করুন...

0️⃣ ফিরতি / Go Back`,
      2: `সাবকন্ট্রাক্টর - আমাদের অংশীদার নেটওয়ার্কে স্বাগতম!
কোম্পানি প্রোফাইল রেজিস্টার করতে এবং আমাদের সাথে কাজ করতে:
• কোম্পানি প্রোফাইল (PDF বা ছবি)
• আপনার/কোম্পানির নাম
• বিশেষজ্ঞতা (নির্মাণ, বৈদ্যুতিক, প্লাম্বিং, এসি, অন্যান্য)
• মোবাইল নম্বর
📝 **আপনার/কোম্পানির নাম** লিখে শুরু করুন...
0️⃣ ফিরতি / Go Back`,
      3: `চাকরীর অনুসন্ধান - আমাদের দলে যুক্ত হওয়ার আগ্রহের জন্য ধন্যবাদ!
আপনার আবেদন সঠিকভাবে পাথরতে আমাকে বলুন: **আপনার পেশা কী?** (ইঞ্জিনিয়ার, টেকনিসিয়ান, বা মজুর)?
0️⃣ ফিরতি / Go Back`,
      4: `🏢 **কোম্পানি প্রোফাইল - স্যান্ড পয়েন্ট গ্লোবাল কন্ট্রাক্টিং**:
সৌদি আরবের পূর্বীয় প্রান্তে অবস্থিত অগ্রণী নির্মাণ কোম্পানি

🏗️ **আমাদের সেক্টর**:
• সাধারণ নির্মাণ, আবাসন ও বাণিজ্যিক ভবন
• পূর্বাধার ও রাস্তা
• বৈদ্যুতিক ও যান্ত্রিক স্টেশন
• জল শোধন ও আবর্জনা
• সরকারি ও বেসরকারি সুবিধার রক্ষণাবেক্ষণ ও পরিচালনা

📜 **প্রমাণপত্র**:
• স্থানীয় উন্নয়ন মন্ত্রণালয়ের শ্রেণীকরণ
• ISO 9001, 14001, 45001
• সৌদি চ্যাম্বার্স সদস্যতা

🏆 **আমাদের প্রকল্প**:
• পূর্বীয় প্রান্ত মিউনিসিপালিটি
• সৌদি আরামকো
• রাজা কমিশন
• মন্ত্রণালয় শিক্ষা

📝 মূল মেনুতে ফিরতি **9** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`,
      5: `📍 **যোগাযোগের তথ্য - স্যান্ড পয়েন্ট গ্লোবাল**:

📍 ঠিঠি: ঢাকা - পূর্বীয় প্রান্ত - সৌদি আরব
📞 ফোন: +966 543120557
📱 হোয়াটসঅ্যাপ: +966 543120557
📧 ইমেল: info@sandpointglobal.com
🌐 ওয়েবসাইট: www.sandpointglobal.com

⏰ কাজের সময়:
রববার - বৃহস্পতি 7:30 AM - 3:30 PM
শুক্রবার - শনিবার: বন্দ

📝 মূল মেনুতে ফিরতি **9** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`
    },
    prompts: {
      name: 'পূর্ণ নাম',
      phone: 'মোবাইল নম্বর',
      specialty: 'বিশেষজ্ঞতা',
      details: 'বিবরণী',
      profession: 'আপনার পেশা',
      property_type: 'সম্পত্তির ধরন',
      work_type: 'কাজের ধরন (নতুন নির্মাণ, রెனوভেশন, মেরামত)',
      area: 'ক্ষেত্রফল (বর্গ মিটার)',
      district: 'জেলা/পড়োস্বাস ঢাকামে',
      cv_files: 'সিভি ফাইল (PDF)',
      work_files: 'কাজের ছবি/ভিডিও',
      company_profile: 'কোম্পানি প্রোফাইল (PDF বা ছবি)',
      invalid_phone: '❌ অমান্য ফোন নম্বর। একটি বৈধ সৌদি নম্বর লিখুন (যেমন: 05XXXXXXXX বা +9665XXXXXXXX):',
      invalid_name: '❌ নাম খুবই ছোট। আপনার পূর্ণ নাম লিখুন:',
      invalid_profession: '❌ একটি বৈধ পেশা নির্বাচন করুন: ইঞ্জিনিয়ার, টেকনিসিয়ান, বা মজুর।',
      thank_you: 'স্যান্ড পয়েন্ট গ্লোবাল-এর সাথে যোগাযোগের জন্য ধন্যবাদ। আমরা আপনার বার্তাটি পেয়েছি এবং শীঘ্রই ফিরে যাব। 🌟',
      engineer_prompt: '✅ আপনার আবেদনটি আমাদের ইঞ্জিনিয়ারিং বিভাগে পাঠানো হবে। অনুগ্রহ করে আপনার CV (PDF) সংযুক্ত করুন। অথবা ফাইল ছাড়া চালিয়ে জানতে **done** লিখুন।',
      worker_prompt: '✅ আপনার দক্ষতা মূল্যায়ন করতে অনুগ্রহ করে আপনার পূর্বের কাজের ছবি বা ভিডিও সংযুক্ত করুন। অথবা ফাইল ছাড়া চালিয়ে জানতে **done** লিখুন।'
    },
    summary: `✅ আপনার অনুরোধটি সফলভাবে গৃহীত হয়েছে!\n📋 রেজিস্টার করা বিবরণী:\n• নাম: {name}\n• মোবাইল: {phone}\n• বিবরণী: {details}\n\n📞 আমাদের ফোন: +966 543120557\n🕐 আমরা 24 ঘণ্টার মধ্যে আপনার সাথে যুক্ত হব।\nস্যান্ড পয়েন্ট গ্লোবাল-এ আপনার বিশ্বাসের জন্য ধন্যবাদ 🌟\n\n📝 মূল মেনুতে ফিরতি **9** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`,
    menuTitle: '📋 সেবা মেনু - স্যান্ড পয়েন্ট গ্লোবাল',
    menuOptions: [
      {
        title: 'আমাদের সেবাগুলি',
        rows: [
          { title: '1️⃣ নতুন গ্রাহক', description: 'মূল্য আঁচন বা প্রশ্ন' },
          { title: '2️⃣ সাবকন্ট্রাক্টর', description: 'স্যান্ড পয়েন্টের সাথে অংশীদারশী' },
          { title: '3️⃣ চাকরীর অনুসন্ধান', description: 'আমাদের দলে যুক্ত হন' },
          { title: '4️⃣ কোম্পানি প্রোফাইল', description: 'আমাদের সম্পর্কে আরও জানুন' },
          { title: '5️⃣ যোগাযোগের তথ্য', description: 'আমাদের ঠিঠি এবং কাজের সময়' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 আপনার ভাষা নির্বাচন করুন',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'সৌদি ডিয়ালেক্ট' },
          { title: '🇬🇧 English', description: 'ইংরেজি ভাষা' },
          { title: '🇵🇰 اردو (Urdu)', description: 'উর্দু ভাষা' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'নেপালি ভাষা' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'বাংলা ভাষা' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'হিন্দি ভাষা' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'ট্যাগালog ভাষা' }
        ]
      }
    ]
  },
  hi: {
    greeting: `सैंड पॉइंट ग्लोबल कंट्राक्टिंग (SAND POINT GLOBAL) - दम्मम में स्वागत है 🏗️
हम ईस्टर्न प्रांट में एक अग्रणी सउदी निर्माण कंपनी हैं!
कृपया नीचे से सेवा चुनें:`,
    options: {
      1: `नए ग्राहक - हम आपकी सेवा करने के लिए खुश हैं!
सर्वश्रेष्ठ सेवा देने के लिए हमें चाहिए:
• सम्पत्ति का प्रकार (बाग़मती, व्यावसायिक, औद्योगिक आदि)
• काम का प्रकार (नई निर्माण, रीनोवेशन, मरम्मत)
• सम्पत्ति का क्षेत्रफल वर्ग मीटर में
• दम्मम का डिस्ट्रिक्ट/पड़ोस
📝 **अपना नाम** से शुरू करें...

0️⃣ वापसी / Go Back`,
      2: `सबकंट्राक्टर - हमारे साझेदार नेटवर्क में स्वागत है!
अपनी कंपनी प्रोफाइल रजिस्टर करने और हमके साथ काम करने के लिए:
• कंपनी प्रोफाइल (PDF या छवि)
• आपका/कंपनी का नाम
• आपका विशेषज्ञता (निर्माण, बिजली, प्लंबिंग, एसी, अन्य)
• मोबाइल नंबर
📝 **आपका/कंपनी का नाम** से शुरू करें...
0️⃣ वापसी / Go Back`,
      3: `नौकरी की तलाश - हमारी टीम में जुड़ने के लिए धन्यवाद!
अपने आवेदन को सही ढंग से मार्गदर्शित करने के लिए, बताइए: **आपका पेशा क्या है?** (इंजीनियर, टेक्नीशियन, या मजदूर)?
0️⃣ वापसी / Go Back`,
      4: `🏢 **कंपनी प्रोफाइल - सैंड पॉइंट ग्लोबल कंट्राक्टिंग**:
सउदी अरब के पूर्वी प्रांट, दम्मम में स्थित एक अग्रणी निर्माण कंपनी

🏗️ **हमारे सेक्टर**:
• सामान्य ठेकरदारी, आवासीय एवं वाणिज्ज़्य इमारतें
• पूर्वाधार और सड़कें
• विद्युत और यांत्रिक स्टेशन
• जल शोधन और अपशिष्ट
• सरकारी और निजी सुविधाओं की रखरखाव और संचालन

📜 **प्रमाणपत्र**:
• स्थानीय विकास मंत्रालय का वर्गीकरण
• ISO 9001, 14001, 45001
• सउदी चैंबर्स सदस्यता

🏆 **हमारे प्रोजेक्ट्स**:
• पूर्वी प्रांट नगरपालिका
• सउदी अरामको
• राजा योजना
• शिक्षा मंत्रालय

📝 मुख्य मेन्यू में वापसी हेतु **9** लिखें या संपर्क **0** लिखें...`,
      5: `📍 **संपर्क जानकारी - सैंड पॉइंट ग्लोबल**:

📍 पता: दम्मम - पूर्वी प्रांट - सउदी अरब
📞 फ़ोन: +966 543120557
📱 व्हाट्सऐप: +966 543120557
📧 ईमेल: info@sandpointglobal.com
🌐 वेबसाइट: www.sandpointglobal.com

⏰ काम का समय:
रवि - गुरु 7:30 AM - 3:30 PM
शुक्र - शनि: बंद

📝 मुख्य मेन्यू में वापसी हेतु **9** लिखें या संपर्क **0** लिखें...`
    },
    prompts: {
      name: 'पूरा नाम',
      phone: 'मोबाइल नंबर',
      specialty: 'विशेषज्ञता क्षेत्र',
      details: 'विवरण',
      profession: 'आपका पेशा',
      property_type: 'संपत्ति का प्रकार',
      work_type: 'काम का प्रकार (नई निर्माण, ढाँचा, मरम्मत)',
      area: 'क्षेत्रफल (वर्ग मीटर)',
      district: 'डिस्ट्रिक्ट/पड़ोस दम्मम में',
      cv_files: 'सीवी फ़ाइल (PDF)',
      work_files: 'काम की तस्वीरें/वीडियो',
      company_profile: 'कंपनी प्रोफाइल (PDF या छवि)',
      invalid_phone: '❌ अमान्य फ़ोन नंबर। एक वैध सउदी नंबर लिखें (जैसे: 05XXXXXXXX या +9665XXXXXXXX):',
      invalid_name: '❌ नाम बहुत छोटा है। अपना पूरा नाम लिखें:',
      invalid_profession: '❌ एक वैध पेशा चुनें: इंजीनियर, टेक्नीशियन, या मजदूर।',
      thank_you: 'सैंड पॉइंट ग्लोबल से संपर्क करने के लिए धन्यवाद। हमने आपका संदेश प्राप्त कर लिया है और जल्द ही उत्तर देंगे। 🌟',
      engineer_prompt: '✅ आपका आवेदन हमारे इंजीनियरिंग विभाग के पास पहुंचेगा। कृपया अपना CV (PDF) संलग्न करें। या बिना फ़ाइल के आगे बढ़ने के लिए **done** लिखें।',
      worker_prompt: '✅ आपकी प्रतिभा का मूल्यांकन करने के लिए कृपया अपने पिछले काम की तस्वीरें या वीडियो संलग्न करें। या बिना फ़ाइल के आगे बढ़ने के लिए **done** लिखें।'
    },
    summary: `✅ आपका अनुरोध सफलतापूर्वक प्राप्त हो गया!\n📋 दर्ज विवरण:\n• नाम: {name}\n• मोबाइल: {phone}\n• विवरण: {details}\n\n📞 हमारा फ़ोन: +966 543120557\n🕐 हम 24 घंटे के भीतर आपसे संपर्क करेंगे।\nसैंड पॉइंट ग्लोबल पर भरोसेमंद होने के लिए धन्यवाद 🌟\n\n📝 मुख्य मेन्यू में वापसी हेतु **9** लिखें या संपर्क **0** लिखें...`,
    menuTitle: '📋 सेवा मेन्यू - सैंड पॉइंट ग्लोबल',
    menuOptions: [
      {
        title: 'हमारी सेवाएं',
        rows: [
          { title: '1️⃣ नए ग्राहक', description: 'कीमत अनुमान या प्रश्न' },
          { title: '2️⃣ सबकंट्राक्टर', description: 'सैंड पॉइंट के साथ साझेदारी' },
          { title: '3️⃣ नौकरी की तलाश', description: 'हमारी टीम में जुड़ें' },
          { title: '4️⃣ कंपनी प्रोफाइल', description: 'हमांरे बारे में अधिक जानें' },
          { title: '5️⃣ संपर्क जानकारी', description: 'हमारा पता, फोन और काम का समय' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 अपनी भाषा चुनें',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'साउदी डायलैक्ट' },
          { title: '🇬🇧 English', description: 'इंग्लिश भाषा' },
          { title: '🇵🇰 اردو (Urdu)', description: 'उर्दु भाषा' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'बंग्ला भाषा' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिंदी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'टैगालॉग भाषा' }
        ]
      }
    ]
  },
  tl: {
    greeting: `Tugon sa Sand Point Global Contracting (SAND POINT GLOBAL) - Dammam 🏗️
Kami ay isang naileading na Saudi kontratista sa Eastern Province!
Pumili ng serbisyo mula sa listahan sa ibaba:`,
    options: {
      1: `Bagong Kliyente - Natutuwa kaming magsilbi sa'yo!
Para sa pinakamagandang serbisyo, kailangan namin:
• Uri ng property (tirahan, commercial, industrial, iba pa)
• Uri ng trabaho (bagong gawa, rehabilitasyon, panuturis)
• Sukat property sa square meters
• Distrito/Kapitbahay sa Dammam
📝 Magsimula sa **iyong pangalan**...

0️⃣ Bumalik / Go Back`,
      2: `Subcontractor - Maligayang pagdating sa aming partner network!
Upang mag-register at magsama-sama sa amin:
• Kumpanya profile (PDF o larawan)
• Pangalan mo/kumpanya
• Espesyalisasyon mo (Konstruksyon, Elektura, Plomero, AC, iba pa)
• Mobile number
📝 Magsimula sa **pangalan mo/kumpanya**...
0️⃣ Bumalik / Go Back`,
      3: `Job Seeker - Salamat sa iyong interes!
Upang maupo ang iyong application nang tama, sabihin mo: **Ano ang iyong propesyon?** (Inhenyero, Tekniko, o Manggagawa)?
0️⃣ Bumalik / Go Back`,
      4: `🏢 **Kumpanya Profile - Sand Point Global Contracting (SAND POINT GLOBAL)**:
Isang naileading na Saudi kontratista sa Dammam, Eastern Province

🏗️ **Aming Sekto**:
• General kontraksyon, tahanan at commercial na gusali
• Infrastruktura at kalsada
• Electrical at mekanikal na stasyon
• Treatment at sewage
• Pamamaraas at operasyon ng gobyerno at pribadong facility

📜 **Sertipiko**:
• Ministra ng Lungsod at Probinsya
• ISO 9001, 14001, 45001
• Kasama sa Saudi Chambers

🏆 **Mga Proyekto**:
• Lungsod ng Eastern Province
• Aramco ng Saudi
• Raja Komisyon
• Kagawaran ng Edukasyon

📝 I-to **9** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`,
      5: `📍 **Contact Information - Sand Point Global**:

📍 Tugon: Dammam - Eastern Province - Saudi Arabia
📞 Telepono: +966 543120557
📱 WhatsApp: +966 543120557
📧 Email: info@sandpointglobal.com
🌐 Website: www.sandpointglobal.com

⏰ Oras ng trabaho:
Linggo - Huwebes 7:30 AM - 3:30 PM
Biyernes - Sabado: Sarado

📝 I-to **9** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`
    },
    prompts: {
      name: 'Buong Pangalan',
      phone: 'Mobile Number',
      specialty: 'Espesyalisasyon',
      details: 'Detalye',
      profession: 'Iyong propesyon',
      property_type: 'Uri ng property',
      work_type: 'Uri ng Trabaho (bagong gawa, rehabilitasyon, panuturis)',
      area: 'Sukat (square meters)',
      district: 'Distrito/Kapitbahay sa Dammam',
      cv_files: 'CV File (PDF)',
      work_files: 'Mga litrato/video ng trabaho',
      company_profile: 'Kumpanya profile (PDF o larawan)',
      invalid_phone: '❌ Di-wastong numero. Mangyaring ilagay ang isang tamang Saudi numero (hal: 05XXXXXXXX o +9665XXXXXXXX):',
      invalid_name: '❌ Masyadong maikli ang pangalan. Paksulat ang iyong buong pangalan:',
      invalid_profession: '❌ Pakpili ng isang wastong propesyon: Inhenyero, Tekniko, o Manggagawa.',
      thank_you: 'Salamat sa pakikipag-ugnayan sa Sand Point Global. Makikipag-ugnayan ang aming koponan. 🌟',
      engineer_prompt: '✅ Ang iyong application ay isusuri ng aming engineering departamento. Paki-attach ang iyong CV (PDF). O i-type **done** kung wala kang file.',
      worker_prompt: '✅ Upang masuri ang kompetensya mo, pakisamang mga litrato o video ng iyong nakaraang trabaho. O i-type **done** kung wala kang file.'
    },
    summary: `✅ Natanggap ang iyong kahilingan!\n📋 Detalye:\n• Pangalan: {name}\n• Mobile: {phone}\n• Detalye: {details}\n\n📞 Telepono namin: +966 543120557\n🕐 Makikipag-ugnayan kami sa loob ng 24 na oras.\nSalamat sa tiwala sa Sand Point Global 🌟\n\n📝 I-to **9** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`,
    menuTitle: '📋 Serbisyong Menu - Sand Point Global',
    menuOptions: [
      {
        title: 'Aming Mga Serbisyo',
        rows: [
          { title: '1️⃣ Bagong Kliyente', description: 'Hilingin ang presyo o query' },
          { title: '2️⃣ Subcontractor', description: 'Maging partner ng Sand Point' },
          { title: '3️⃣ Job Seeker', description: 'Sumali sa aming koponan' },
          { title: '4️⃣ Kumpanya na Profile', description: 'Alamin pa tungkol sa amin' },
          { title: '5️⃣ Contact Info', description: 'Atin, telepono, at oras ng trabaho' }
        ]
      }
    ],
    languageList: [
      {
        title: '🌍 Piliin ang iyong wika',
        rows: [
          { title: '🇸🇦 العربية (Arabic)', description: 'Saudi dialect' },
          { title: '🇬🇧 English', description: 'English language' },
          { title: '🇵🇰 اردو (Urdu)', description: 'اردو زبان' },
          { title: '🇳🇵 नेपाली (Nepali)', description: 'नेपाली भाषा' },
          { title: '🇧🇩 বাংলা (Bengali)', description: 'বাংলা ভাষা' },
          { title: '🇮🇳 हिंदी (Hindi)', description: 'हिंदी भाषा' },
          { title: '🇵🇭 Tagalog (Filipino)', description: 'Tagalog na wika' }
        ]
      }
    ]
  }
};

const LANG_CODES = {
  '1': 'ar',
  '2': 'en',
  '3': 'ur',
  '4': 'ne',
  '5': 'bn',
  '6': 'hi',
  '7': 'tl'
};

async function sendListMessage(sock, userId, text, title, sections) {
  await safePresence(sock, userId);
  await humanDelay();

  let body = '';
  if (text) body += text + '\n\n';
  if (title) body += '*' + title + '*\n';

  let num = 0;
  for (const section of sections) {
    for (const row of section.rows || []) {
      num++;
      const emoji = /^\d+️⃣/.test(row.title) ? '' : `${num}️⃣ `;
      body += `\n${emoji}${row.title}` + (row.description ? ` - ${row.description}` : '');
    }
  }
  body += '\n\n📝 اكتب رقم الاختيار / Type the number';

  await sendWithRetry(sock, userId, { text: body });
}

async function sendLanguageList(sock, userId) {
  await safePresence(sock, userId);
  await humanDelay();

  const body =
    '🌍 اختر لغة التواصل / Please choose your language / الرجاء اختيار لغة التواصل\n\n' +
    '1️⃣ 🇸🇦 العربية (Arabic)\n' +
    '2️⃣ 🇬🇧 English\n' +
    '3️⃣ 🇵🇰 اردو (Urdu)\n' +
    '4️⃣ 🇳🇵 नेपाली (Nepali)\n' +
    '5️⃣ 🇧🇩 বাংলা (Bengali)\n' +
    '6️⃣ 🇮🇳 हिंदी (Hindi)\n' +
    '7️⃣ 🇵🇭 Tagalog (Filipino)\n\n' +
    '📝 اكتب رقم اللغة / Type the number';

  await sendWithRetry(sock, userId, { text: body });
}

async function sendWelcomeBundle(sock, userId) {
  const tAr = LANG_MESSAGES.ar;
  await sendHumanLikeMessage(sock, userId, tAr.greeting);
  await sendLanguageList(sock, userId);
  getUserState(userId);
  updateUserState(userId, { first_contact: false });
}

async function sendProfessionList(sock, userId, t, userState) {
  await safePresence(sock, userId);
  await humanDelay();

  const lang = userState.language || 'en';
  const body =
    t.options['3'] + '\n\n' +
    '💼 ' + (lang === 'ar' ? 'ماهي مهنتك؟' : 'What is your profession?') + '\n\n' +
    '1️⃣ ' + (lang === 'ar' ? '👨‍💼 مهندس' : '👨‍💼 Engineer') + ' - ' + (lang === 'ar' ? 'مهندس مدنى أو ميكانيكي' : 'Civil or Mechanical Engineer') + '\n' +
    '2️⃣ ' + (lang === 'ar' ? '🔧 تقني' : '🔧 Technician') + ' - ' + (lang === 'ar' ? 'تقني مختبر' : 'Lab Technician or Supervisor') + '\n' +
    '3️⃣ ' + (lang === 'ar' ? '👷 عامل' : '👷 Worker') + ' - ' + (lang === 'ar' ? 'عامل بناء أو نجار' : 'Construction Worker or Carpenter') + '\n\n' +
    '0️⃣ للرجوع وتغيير اللغة / Go Back';

  await sendWithRetry(sock, userId, { text: body });
}

async function handleMessage(sock, m) {
  try {
    return await handleMessageInner(sock, m);
  } catch (err) {
    console.error('💥 handleMessage error:', err.message);
    try {
      const userId = m.key.remoteJid;
      await sendWithRetry(sock, userId, { text: '⚠️ حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى. / An unexpected error occurred, please try again.' });
    } catch (e) {}
  }
}

async function handleMessageInner(sock, m) {
  if (!m.message) return;
  
  const userId = m.key.remoteJid;
  const isGroup = userId.endsWith('@g.us');

  if (isGroup) return;
  
  const messageText = m.message.conversation || m.message.extendedTextMessage?.text || '';
  // Sanitize Arabic numerals early so all logic uses Western digits
  const text = sanitizeArabicNumerals(messageText.trim());
  
  // ===== STRICT GLOBAL RESET OVERRIDE =====
  // If user types exactly "0", "back", or "تعديل" - completely wipe their data and restart
  const exactResetCommands = ['0', 'back', 'تعديل'];
  if (exactResetCommands.includes(text)) {
    // Completely delete user from users.json
    if (usersData[userId]) {
      delete usersData[userId];
      saveUsers();
    }
     // Force-send welcome bundle (logo + greeting + menu + language list)
     await sendWelcomeBundle(sock, userId);
    return;
  }
  // ===== END STRICT OVERRIDE =====
  
  const userState = getUserState(userId);
  
  let hasAttachment = false;
  let attachmentInfo = {};
  
  if (m.message.documentMessage) {
    hasAttachment = true;
    attachmentInfo = { type: 'document', fileName: m.message.documentMessage.fileName || 'file', size: m.message.documentMessage.fileLength ? Number(m.message.documentMessage.fileLength) : 'unknown' };
  } else if (m.message.imageMessage) {
    hasAttachment = true;
    attachmentInfo = { type: 'image', fileName: 'image.jpg', size: m.message.imageMessage.fileLength ? Number(m.message.imageMessage.fileLength) : 'unknown' };
  } else if (m.message.videoMessage) {
    hasAttachment = true;
    attachmentInfo = { type: 'video', fileName: 'video.mp4', size: m.message.videoMessage.fileLength ? Number(m.message.videoMessage.fileLength) : 'unknown' };
  }
  
  const saveAttachment = (userId, attachment) => {
    const user = getUserState(userId);
    if (!user.files) user.files = [];
    user.files.push({ ...attachment, timestamp: new Date().toISOString() });
    updateUserState(userId, { files: user.files });
  };
  
  const sendMsg = async (msg, mentions = []) => {
    await sendHumanLikeMessage(sock, userId, msg);
  };
  
  if (hasAttachment) {
    saveAttachment(userId, attachmentInfo);
  }
  
  if (text === '/start' || text === 'restart' || text.toLowerCase() === 'cancel') {
    resetUserState(userId);
    await sendWelcomeBundle(sock, userId);
    return;
  }
  
  if (hasAttachment) {
    const lang2 = userState.language || 'en';
    const t2 = LANG_MESSAGES[lang2];
    if (userState.step === 'collect_details' && ['1', '2', '3'].includes(userState.category)) {
      await sendMsg(`✅ ${lang2 === 'ar' ? 'تم استلام ملفكم بنجاح' : 'File received successfully'}! ${attachmentInfo.fileName}\n\n${lang2 === 'ar' ? '📝 اكتبوا' : '📝 Type'} **${lang2 === 'ar' ? 'تم' : 'done'}** ${lang2 === 'ar' ? 'للإنهاء' : 'to finish'}...`);
      return;
    }
  }
  
  if (!text && !hasAttachment) return;
  
  // Language selection step
  if (userState.step === 'language') {
    if (['1', '2', '3', '4', '5', '6', '7'].includes(text)) {
      const langCode = LANG_CODES[text];
      updateUserState(userId, { language: langCode, step: 'greeting', category: null, first_contact: false });
      const tLang = LANG_MESSAGES[langCode];
      // Send company logo with greeting, then the service menu
      const LOGO_PATH = join(__dirname, 'assets', 'logo.jpg');
      await sendImageMessage(sock, userId, LOGO_PATH, tLang.greeting);
      await sendListMessage(sock, userId, '', tLang.menuTitle, tLang.menuOptions);
    } else if (userState.first_contact) {
      await sendWelcomeBundle(sock, userId);
    } else {
      await sendLanguageList(sock, userId);
    }
    return;
  }
  
  const lang = userState.language || 'en';
  const t = LANG_MESSAGES[lang];
  const backOption = lang === 'ar' ? '0️⃣ للرجوع وتغيير اللغة / Go Back' : '0️⃣ Go Back / تغيير اللغة';
  
  // Global "9" button always returns to main menu (unless already there)
  if (text === '9' && userState.step !== 'greeting' && userState.step !== 'language') {
    updateUserState(userId, { step: 'greeting' });
    await sendListMessage(sock, userId, t.greeting, t.menuTitle, t.menuOptions);
    return;
  }
  
  // Main greeting menu
  if (userState.step === 'greeting') {
    if (['1', '2', '3', '4', '5'].includes(text)) {
      if (text === '4') {
        // Send company profile PDF
        const PDF_PATH = join(__dirname, 'assets', 'Sand Point  Profile .pdf');
        await sendDocumentMessage(sock, userId, PDF_PATH, 'Sand Point Profile.pdf', t.options['4']);
        await sendListMessage(sock, userId, '', t.menuTitle, t.menuOptions);
        return;
      }
      if (text === '5') {
        await sendMsg(t.options[text]);
        await sendListMessage(sock, userId, '', t.menuTitle, t.menuOptions);
        return;
      }
      if (text === '3') {
        updateUserState(userId, { step: 'collect_profession', category: text });
        await sendProfessionList(sock, userId, t, userState);
        return;
      } else {
        updateUserState(userId, { step: 'collect_name', category: text });
        await sendMsg(t.options[text]);
      }
    } else {
      await sendListMessage(sock, userId, t.greeting, t.menuTitle, t.menuOptions);
    }
    return;
  }
  
  // Profession selection (Job Seeker path)
  if (userState.step === 'collect_profession') {
    const lowerText = text.toLowerCase();
    let profession = null;
    
    if (text === '1' || lowerText.includes('engineer') || lowerText.includes('مهندس') || lowerText.includes('इन्जिनियर') || lowerText.includes('ইঞ্জিনিয়ার')) {
      profession = 'engineer';
    } else if (text === '2' || lowerText.includes('technician') || lowerText.includes('تقني') || lowerText.includes('टेक्निशियन') || lowerText.includes('টেকনিসিয়ান')) {
      profession = 'technician';
    } else if (text === '3' || lowerText.includes('worker') || lowerText.includes('عامل') || lowerText.includes('मजदुर') || lowerText.includes('মজুর') || lowerText.includes('trabaho') || lowerText.includes('manggagawa')) {
      profession = 'worker';
    }
    
    if (profession) {
      updateUserState(userId, { profession: profession, step: 'collect_name' });
      await sendMsg(`✅ ${t.prompts.thank_you}\n${lang === 'ar' ? 'الآن نحتاج' : 'Now we need'}\n• ${t.prompts.name}\n• ${t.prompts.phone}\n📝 ${lang === 'ar' ? 'ابدأ بـ' : 'Start with'} **${t.prompts.name}**...\n\n${backOption}`);
    } else {
      const professionOptions = lang === 'ar' ? '(مهندس، تقني، أم عامل)' : '(Engineer, Technician, or Worker)';
      await sendMsg('❌ ' + t.prompts.invalid_profession + ' ' + professionOptions + '...\n\n' + backOption);
    }
    return;
  }
  
  // Name collection
  if (userState.step === 'collect_name') {
    if (text.length < 2) {
      await sendMsg('❌ ' + t.prompts.invalid_name + '\n\n' + backOption);
      return;
    }
    updateUserState(userId, { name: text, step: 'collect_phone' });
    await sendMsg(`[${t.prompts.thank_you}] ${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.phone}** (${lang === 'ar' ? 'مثال: 05XXXXXXXX' : 'e.g., 05XXXXXXXX'}):\n\n${backOption}`);
    return;
  }
  
  // Phone validation
  if (userState.step === 'collect_phone') {
    const cleanPhone = text.replace(/[\s-]/g, '');
    const validatedPhone = validateSaudiPhone(cleanPhone);
    if (!validatedPhone) {
      await sendMsg('❌ ' + t.prompts.invalid_phone + '\n\n' + backOption);
      return;
    }
    updateUserState(userId, { phone: validatedPhone, step: 'collect_details', collect_step: 0 });
    
    
     if (userState.category === '1') {
      await sendMsg(`✅ ${lang === 'ar' ? 'لكم التسجيل!' : '✅ Registration complete!'} ${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.property_type}** ${lang === 'ar' ? '(سكني، تجاري، صناعي...)' : '(residential, commercial, industrial...)' }: \n\n${backOption}`);
    } else if (userState.category === '2') {
      await sendMsg(`✅ ${lang === 'ar' ? 'عشان نرفع ملفك لقسم المشاريع،' : '✅ To register your profile,'} ${lang === 'ar' ? 'نحتاج' : 'we need'}:\n• ${t.prompts.company_profile}\n• ${t.prompts.specialty}\n📝 ${lang === 'ar' ? 'ابدأ بـ' : 'Start with'} **${t.prompts.specialty}** أو أرفق الملف الآن...\n\n${backOption}`);
    } else if (userState.category === '3') {
      if (userState.profession === 'engineer' || userState.profession === 'technician') {
        await sendMsg(`✅ ${t.prompts.engineer_prompt}\n\n${backOption}`);
      } else {
        await sendMsg(`✅ ${t.prompts.worker_prompt}\n\n${backOption}`);
      }
    }
    return;
  }
  
  // Property details collection (New Client path)
  if (userState.step === 'collect_details') {
    if (userState.category === '1') {
      if (text === 'تم' || text.toLowerCase() === 'done' || text.toLowerCase() === 'finish') {
        updateUserState(userId, { step: 'complete' });
        saveRegistrationToSheet(userId, userState);
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.details || text);
        const thankYou = lang === 'ar' 
          ? `🙏 ${t.prompts.thank_you}\n\n${backOption}`
          : `${t.prompts.thank_you}\n\n${backOption}`;
        await sendMsg(thankYou);
        await sendMsg(summary);
        // Stay dormant - do NOT send menu
      } else if (userState.collect_step === 0) {
        updateUserState(userId, { details: text, collect_step: 1 });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.work_type}**:\n\n${backOption}`);
      } else if (userState.collect_step === 1) {
        updateUserState(userId, { details: userState.details + ' - ' + text, collect_step: 2 });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.area}**:\n\n${backOption}`);
      } else if (userState.collect_step === 2) {
        updateUserState(userId, { details: userState.details + ' - ' + text, collect_step: 3 });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.district}** (${lang === 'ar' ? 'الحي / المنطقة' : 'neighborhood in Dammam'}):\n\n${backOption}`);
      } else {
        updateUserState(userId, { details: userState.details + ' - ' + text, collect_step: 0 });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? '📝 اكتب' : '📝 Type'} **تم** ${lang === 'ar' ? 'للإنهاء' : 'to finish'}...\n\n${backOption}`);
      }
    } else if (userState.category === '2') {
      if (text === 'تم' || text.toLowerCase() === 'done' || text.toLowerCase() === 'finish') {
        updateUserState(userId, { step: 'complete' });
        saveRegistrationToSheet(userId, userState);
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.specialty);
        const thankYou = lang === 'ar'
          ? `🙏 ${t.prompts.thank_you}\n\n${backOption}`
          : `${t.prompts.thank_you}\n\n${backOption}`;
        await sendMsg(thankYou);
        await sendMsg(summary);
      } else {
        updateUserState(userId, { specialty: text });
        await sendMsg(`✅ ${t.prompts.specialty}: ${text}\n\n${lang === 'ar' ? '✅ عشان نرفع ملفك،' : '✅ To upload your file,'} ${lang === 'ar' ? 'أرفق الملف الآن' : 'attach it now'} ${lang === 'ar' ? 'أو اكتب **تم**' : 'or type **done**'}...\n\n${backOption}`);
      }
    } else if (userState.category === '3') {
      if (text === 'تم' || text.toLowerCase() === 'done' || text.toLowerCase() === 'finish') {
        updateUserState(userId, { step: 'complete' });
        saveRegistrationToSheet(userId, userState);
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.profession);
        const thankYou = lang === 'ar'
          ? `🙏 ${t.prompts.thank_you}\n\n${backOption}`
          : `${t.prompts.thank_you}\n\n${backOption}`;
        await sendMsg(thankYou);
        await sendMsg(summary);
      } else {
        updateUserState(userId, { details: text });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? '📝 اكتب' : '📝 Type'} **${lang === 'ar' ? 'تم' : 'done'}** ${lang === 'ar' ? 'للإنهاء' : 'to finish'}...\n\n${backOption}`);
      }
    }
    return;
  }
  
   // Complete state - stay dormant, do NOT auto-send menu
  if (userState.step === 'complete') {
    // Bot stays dormant. Only reset on explicit trigger like "Hi" or "/start"
    const greetings = ['hi', 'hello', 'مرحبا', 'اهلا', 'hello', 'hey', 'start', 'begin', 'اهلاً', 'اهلا', 'assalam', 'السلام'];
    if (greetings.some(g => text.toLowerCase() === g)) {
      resetUserState(userId);
      await sendWelcomeBundle(sock, userId);
    } else {
      await sendMsg(lang === 'ar' ? '👋 مرحباً مرة أخرى! اكتب 0 للبدء من جديد.' : '👋 Hello again! Type 0 to start over.');
    }
    return;
  }
  
   // Fallback for unknown states
  await sendWelcomeBundle(sock, userId);
 }

let currentQrData = null;
let qrGeneratedAt = null;
let lastDisconnectInfo = null;
let mongoClient = null;
let authCollection = null;

// In-memory log ring buffer for remote diagnostics (Render free = no log access)
const logBuffer = [];
const LOG_BUFFER_MAX = 300;
function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

// MongoDB-backed auth state (mirrors useMultiFileAuthState but persistent across restarts)
async function useMongoAuthState(collection) {
  const writeData = async (id, data) => {
    await collection.updateOne(
      { _id: id },
      { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
      { upsert: true }
    );
  };
  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    } catch (e) {
      return null;
    }
  };
  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch (e) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  const keys = {
    async get(type, ids) {
      const data = {};
      await Promise.all(ids.map(async (id) => {
        let value = await readData(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      }));
      return data;
    },
    async set(data) {
      const tasks = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          tasks.push(value ? writeData(key, value) : removeData(key));
        }
      }
      await Promise.all(tasks);
    }
  };

  return {
    state: { creds, keys: makeCacheableSignalKeyStore(keys) },
    saveCreds: async () => writeData('creds', creds),
    clearState: async () => {
      try {
        await collection.deleteMany({ _id: { $ne: 'creds' } });
      } catch (e) {}
    }
  };
}

async function getAuthState() {
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    try {
      if (!mongoClient) {
        mongoClient = new MongoClient(mongoUri, {
          serverSelectionTimeoutMS: 20000,
          connectTimeoutMS: 20000
        });
        await mongoClient.connect();
        console.log('🗄️ MongoDB session storage: connected');
      }
      if (!authCollection) {
        authCollection = mongoClient.db().collection('wa_sessions');
      }
      return await useMongoAuthState(authCollection);
    } catch (err) {
      console.error('❌ MongoDB connection failed, falling back to local storage:', err.message);
    }
  }
  return await useMultiFileAuthState(join(__dirname, 'auth_info'));
}

// رموز إعادة الاتصال المتوقعة (مطابقة لأرقام baileys 6.7.24)
const DISCONNECT_CODES = {
  BAD_SESSION: 500,
  TOKEN_EXPIRED: 401,
  MULTI_DEVICE_MISMATCH: 411,
  RESTART_REQUIRED: 515,
  FORBIDDEN: 403,
  CONNECTION_REPLACED: 440
};

// دالة اختيار متصفح عشوائي
function getRandomBrowser() {
  const browsers = [
    ['Chrome', '103.0.0.0', 'Linux'],
    ['Safari', '16.0', 'macOS'],
    ['Firefox', '107.0', 'Windows'],
    ['Edge', '107.0.0.0', 'Windows'],
    ['Opera', '93.0.0.0', 'Windows']
  ];
  return process.env.WA_BROWSER
    ? process.env.WA_BROWSER.split(',')
    : browsers[Math.floor(Math.random() * browsers.length)];
}

// Track only ONE active socket - prevents duplicate/conflicting connections
let activeSock = null;
let connectingNow = false;
let isLoggedIn = false;

// Keep the SAME browser identity across reconnects - changing it every time
// (Safari -> Chrome -> Opera...) looks like a hijacked session to WhatsApp
// and triggers repeated "Stream Errored (515)" resets
const BROWSER = getRandomBrowser();

function isSockAlive(sock) {
  try {
    if (!sock) return false;
    // WebSocket OPEN state = 1
    return sock.ws?.readyState === 1;
  } catch (e) {
    return false;
  }
}

function stopSock(sock) {
  if (!sock) return;
  try {
    sock.ev?.removeAllListeners?.();
    sock.end?.();
    sock.ws?.close?.();
  } catch (e) {}
}

// Watchdog: if we're logged in but the socket died silently (no 'close' event
// was processed - e.g. stopSock from a parallel connect removed listeners),
// force a reconnect. Runs every 20s.
setInterval(() => {
  if (isLoggedIn && !connectingNow && !isSockAlive(activeSock)) {
    log('🐕 Watchdog: socket dead while logged in - forcing reconnect');
    connectToWhatsApp().catch(e => log('💥 Watchdog reconnect error:', e.message));
  }
}, 20000);

// Send message with retry - if the socket died, force a reconnect then retry
async function sendWithRetry(sock, jid, messageContent, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Always use the current active socket (may have been replaced by a reconnect)
    const current = (activeSock && activeSock !== sock) ? activeSock : sock;
    try {
      if (!isSockAlive(current)) {
        console.log('⚠️  Socket not alive (attempt ' + attempt + '), reconnecting...');
        await withTimeout(reconnectNow(), 30000, 'reconnect');
        continue;
      }
      // 30s hard timeout - sendMessage must never hang forever
      await withTimeout(current.sendMessage(jid, messageContent), 30000, 'sendMessage');
      consecutiveSendFailures = 0;
      return true;
    } catch (e) {
      consecutiveSendFailures++;
      console.error('❌ sendMessage attempt ' + attempt + ' failed (' + consecutiveSendFailures + 'x): ' + e.message);
      if (consecutiveSendFailures >= SEND_FAILURE_RESET_THRESHOLD) {
        console.log('🛠️  Too many consecutive send failures - resetting session automatically');
        consecutiveSendFailures = 0;
        await resetSessionAndReconnect();
        return false;
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  return false;
}

let reconnectTimer = null;
let consecutiveSendFailures = 0;
const SEND_FAILURE_RESET_THRESHOLD = 5;

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delayMs);
}

async function resetSessionAndReconnect() {
  console.log('🗑️  Session self-heal: resetting authentication...');
  try {
    if (process.env.MONGODB_URI && authCollection) {
      await authCollection.deleteMany({});
      console.log('✅ MongoDB session cleared');
    } else {
      rmSync(join(__dirname, 'auth_info'), { recursive: true, force: true });
      console.log('✅ auth_info cleared');
    }
  } catch (err) {
    console.log('⚠️ Session cleanup error:', err.message);
  }
  mongoClient = null;
  authCollection = null;
  stopSock(activeSock);
  activeSock = null;
  setTimeout(() => connectToWhatsApp(), 3000);
}

async function reconnectNow() {
  stopSock(activeSock);
  activeSock = null;
  await connectToWhatsApp();
}

async function connectToWhatsApp() {
  if (connectingNow) {
    log('⏭️ connectToWhatsApp skipped - another connection is already in progress');
    return;
  }
  connectingNow = true;

  // Only one connection at a time - kill any existing socket first
  stopSock(activeSock);
  activeSock = null;

  try {
    log('\n🔄 Starting WhatsApp connection (QR mode)...');

    const { state, saveCreds, clearState } = await getAuthState();

    const { version, isLatest } = await fetchLatestBaileysVersion();
    log("Baileys version: " + version.join(".") + " - Latest: " + isLatest);

    const sock = makeWASocket({
      version,
      auth: state,
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
      // markOnlineOnConnect sends presence immediately after pairing - this is the
      // known cause of "Stream Errored (515)" right after a successful QR scan.
      // Keep it off until the connection is fully established.
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      // SAME browser identity on every reconnect (see BROWSER const above)
      browser: ['SAND POINT Bot', BROWSER[0], BROWSER[1]],
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      qrTimeout: 60000
    });

    activeSock = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;
      log('📡 connection.update:', JSON.stringify({ connection, isNewLogin: isNewLogin ?? false, hasQr: !!qr }));

      if (isNewLogin) {
        log('🎉✅ QR SCANNED SUCCESSFULLY! Phone linked. Saving session...');
      }

      if (qr) {
        log('🆕 New QR received from WhatsApp server');
        try {
          QRCode.toDataURL(qr, { width: 350, margin: 4, errorCorrectionLevel: 'H', color: { dark: '#000', light: '#fff' } })
            .then(qrImageDataUrl => {
              currentQrData = qrImageDataUrl;
              qrGeneratedAt = Date.now();
              log('📱 QR ready at ' + (process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + (process.env.PORT || 3000)) + '/qr');
            })
            .catch(e => log('❌ QR generation error:', e.message));
        } catch (e) {
          log('❌ QR generation error:', e.message);
        }
      }

      if (connection === 'open') {
        isLoggedIn = true;
        log('✅ Connected to WhatsApp with browser: ' + BROWSER[0]);
        log('🤖 Bot ready (7 languages + anti-ban protection)...');
        currentQrData = null;
        qrGeneratedAt = null;
      }

      if (connection === 'close') {
        // This socket is dead - clear it BEFORE reconnecting
        if (activeSock === sock) activeSock = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        log('❌ Disconnected (code: ' + statusCode + '):', lastDisconnect?.error?.message);
        log('   error stack:', lastDisconnect?.error?.stack || 'n/a');
        lastDisconnectInfo = { code: statusCode, message: lastDisconnect?.error?.message, at: new Date().toISOString() };

        // The QR displayed on /qr is now DEAD - clear it so clients never scan a stale code
        currentQrData = null;
        qrGeneratedAt = null;

        // Codes requiring session reset (session is truly dead - phone unlinked/rejected)
        const codesRequiringReset = [
          DisconnectReason.loggedOut,
          DisconnectReason.badSession,
          DisconnectReason.multideviceMismatch,
          DisconnectReason.forbidden
        ];

        // restartRequired (515) means: close and reconnect KEEPING the session -
        // wiping it here creates an infinite scan->515->wipe->scan loop (seen in logs)
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;

        if (isRestartRequired) {
          // Session stays saved - a quick reconnect with the SAME creds is all that's needed.
          // If the creds were wiped we'd loop scan->515->wipe forever.
          log('🔁 Stream errored (515) - reconnecting NOW with the SAME session');
          scheduleReconnect(2000);
        } else if (codesRequiringReset.includes(statusCode)) {
          isLoggedIn = false;
          log('🗑️  Clearing session for code ' + statusCode + '...');
          try {
            if (process.env.MONGODB_URI) {
              // loggedOut (401) means the saved creds are REJECTED by WhatsApp -
              // we must wipe creds too, otherwise every reconnect fails with 401 again
              // and no fresh QR is ever generated (infinite loop without QR)
              await authCollection.deleteMany({});
              log('✅ MongoDB session fully cleared (including creds)');
            } else {
              rmSync(join(__dirname, 'auth_info'), { recursive: true, force: true });
              log('✅ auth_info cleared');
            }
          } catch (cleanupErr) {
            log('⚠️ Cleanup error:', cleanupErr.message);
          }
          mongoClient = null;
          authCollection = null;
          scheduleReconnect(15000);
        } else {
          // Transient errors - keep session and reconnect
          log('🔄 Reconnecting in 8s (keeping session)...');
          scheduleReconnect(8000);
        }
      }
    });

    sock.ev.on('creds.update', () => {
      log('🔑 creds.update fired (phone may have scanned QR)');
      saveCreds().catch(e => log('⚠️ Failed to save creds:', e.message));
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Only process notify messages (user messages), ignore status updates
      if (type !== 'notify') return;
      // Ignore events from stale sockets - only the current active one responds
      if (activeSock !== sock) return;
      
      for (const m of messages) {
        try {
          if (!m.key.fromMe && m.message) {
            // Strict de-duplication: trace message IDs to prevent double replies
            const msgId = m.key.id;
            if (!msgId || isDuplicate(msgId)) continue;
            
            await handleMessage(sock, m);
          }
        } catch (err) {
          console.error('💥 Error handling message:', err.message);
          console.error(err.stack);
        }
      }
    });

    return sock;
  } catch (err) {
    log('💥 Connection error:', err.message);
    log('🔄 Retrying in 10 seconds...');
    setTimeout(() => connectToWhatsApp(), 10000);
  } finally {
    connectingNow = false;
  }
}

let server;

function startServer() {
  const PORT = process.env.PORT || 3000;
  server = http.createServer((req, res) => {
    if (req.url === '/qr' && currentQrData) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>SAND POINT GLOBAL - WhatsApp QR Code</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="refresh" content="10">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; text-align: center; background: #f5f5f5; }
  .container { max-width: 520px; margin: 0 auto; background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  h1 { color: #25D36E; font-size: 22px; margin-bottom: 10px; }
  .qr-wrap { margin: 10px auto; display: flex; justify-content: center; align-items: center; }
  .qr-wrap img { width: 280px; height: 280px; max-width: 90vw; max-height: 90vw; object-fit: contain; display: block; }
  .instructions { margin-top: 10px; color: #555; font-size: 15px; line-height: 1.6; }
  .warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 10px; margin: 12px 0; font-size: 13px; color: #856404; }
  .updated { color: #999; font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
  <div class="container">
    <h1>SAND POINT GLOBAL 🏗️</h1>
    <div class="qr-wrap">
      <img src="${currentQrData}" alt="WhatsApp QR Code" />
    </div>
    <div class="instructions">
      <p><strong>Scan this QR code with WhatsApp</strong></p>
      <p>1️⃣ Open WhatsApp on your phone</p>
      <p>2️⃣ Settings → WhatsApp Web/Desktop</p>
      <p>3️⃣ Tap "Scan QR Code" and scan this code</p>
    </div>
    <div class="warning">
      ⚠️ <strong>Important:</strong> Scan from a DIFFERENT phone.
      The QR code refreshes automatically every 10 seconds - wait for a fresh one before scanning.
      Each QR expires in ~20 seconds.
    </div>
    <div class="updated">🔄 Refreshes automatically every 10 seconds • QR generated at ${new Date(qrGeneratedAt).toLocaleTimeString()} (${Math.floor((Date.now() - qrGeneratedAt) / 1000)}s ago)</div>
  </div>
</body>
</html>`);
    } else if (req.url === '/qr') {
      // No QR yet - show waiting page that auto-refreshes
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>SAND POINT GLOBAL - WhatsApp QR Code</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
  .container { max-width: 400px; margin: 60px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  h1 { color: #25D36E; font-size: 22px; }
</style>
</head>
<body>
  <div class="container">
    <h1>SAND POINT GLOBAL 🏗️</h1>
    <p style="font-size:18px;">⏳ جاري تجهيز رمز QR... / Preparing QR code...</p>
    <p style="color:#999;">سيتم التحديث تلقائياً / This page refreshes automatically</p>
  </div>
</body>
</html>`);
    } else if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', service: 'SAND POINT GLOBAL WhatsApp Bot', qr_available: !!currentQrData }));
    } else if (req.url === '/status') {
      const registered = !!activeSock?.user;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        connected: !!activeSock && isSockAlive(activeSock),
        logged_in: registered,
        qr_available: !!currentQrData,
        socket_alive: !!activeSock && isSockAlive(activeSock),
        session_storage: process.env.MONGODB_URI ? 'mongo' : 'local-files',
        mongo_uri_set: !!process.env.MONGODB_URI,
        send_failures: consecutiveSendFailures,
        qr_age_seconds: currentQrData && qrGeneratedAt ? Math.floor((Date.now() - qrGeneratedAt) / 1000) : null,
        last_disconnect: lastDisconnectInfo,
        uptime_seconds: Math.round(process.uptime())
      }));
    } else if (req.url === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(logBuffer.join('\n'));
    } else if (req.url === '/reset-session') {
      (async () => {
      log('🛠️  Manual /reset-session requested');
      try {
        if (process.env.MONGODB_URI && authCollection) {
          await authCollection.deleteMany({});
          log('✅ Mongo session wiped by /reset-session');
        } else {
          rmSync(join(__dirname, 'auth_info'), { recursive: true, force: true });
          log('✅ auth_info wiped by /reset-session');
        }
      } catch (err) {
        log('⚠️ /reset-session cleanup error:', err.message);
      }
      mongoClient = null;
      authCollection = null;
      stopSock(activeSock);
      activeSock = null;
      setTimeout(() => connectToWhatsApp(), 2000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Session reset, reconnecting...' }));
      })();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  
  server.listen(PORT, () => {
    console.log('🌐 Server listening on port ' + PORT);
    if (currentQrData) {
      console.log('📱 QR code available at: http://localhost:' + PORT + '/qr');
    } else {
      console.log('⏳ Waiting for QR code...');
    }
  });
}

loadUsers();
console.log('🚀 بدء تشغيل بوت شركة ساند بوينت للمقاولات (7 لغات + مضادات حظر إنسانيات)...');
startServer();
connectToWhatsApp().catch(console.error);

// NEVER let a single error kill the server silently (on free Render this = dead bot)
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection:', reason?.message || reason);
});
