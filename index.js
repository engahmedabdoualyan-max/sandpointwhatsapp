import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USERS_FILE = join(__dirname, 'users.json');

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
      name: '',
      phone: '',
      specialty: '',
      details: '',
      files: []
    };
    saveUsers();
  }
  return usersData[userId];
}

function updateUserState(userId, updates) {
  usersData[userId] = { ...usersData[userId], ...updates };
  saveUsers();
}

function resetUserState(userId) {
  usersData[userId] = {
    step: 'language',
    language: null,
    category: null,
    profession: null,
    name: '',
    phone: '',
    specialty: '',
    details: '',
    files: []
  };
  saveUsers();
}

async function humanDelay() {
  const delay = Math.floor(Math.random() * 3000) + 2000;
  return new Promise(resolve => setTimeout(resolve, delay));
}

async function sendHumanLikeMessage(sock, userId, message) {
  try {
    await sock.sendPresenceUpdate('composing', userId);
  } catch (e) {}
  await humanDelay();
  await sock.sendMessage(userId, { text: message });
}

const LANG_MESSAGES = {
  ar: {
    greeting: `مرحباً بكم في شركة ساند بوينت العالمية للمقاولات (SAND POINT GLOBAL) - الدمام
نحن شركة مقاولات رائدة في المنطقة الشرقية، ونقدم خدماتنا بأعلى معايير الجودة لاهنت!
يرجى اختيار الخدمة المطلوبة من القائمة:
1️⃣ عميل جديد - استفسار أو طلب عرض سعر
2️⃣ مقاول/مورد - التعاون مع شركة ساند بوينت
3️⃣ باحث عن عمل - الانضمام إلى فريقنا
4️⃣ ملف الشركة - معرفة المزيد عنا
5️⃣ بيانات التواصل - كيف تواصل معانا
📝 اكتب رقم الخيار...`,
    options: {
      1: `عميل جديد - يسرنا كثير إننا نخدمك! عشان نعطيك الصافي والمميز، نحتاج:
• نوع العقار (سكني، تجاري، صناعي، إلخ)
• مساحة العقار بالمتر المربع
• الحي / المنطقة في الدمام
📝 ابدأ بـ **نوع العقار**...`,
      2: `مقاول/مورد - نرحب بك في شبكة شركائنا! عشان نرفع ملفك لقسم المشاريع ونتعامل معك بجدية، نحتاج:
• الملف التجاري (PDF أو صورة)
• اسمك/اسم الشركة
• مجال تخصصك (بناء، كهرباء، سباكة، تكييف، إلخ)
• رقم الجوال
📝 ابدأ بـ **اسمك/اسم الشركة**...`,
      3: `باحث عن عمل - نقدر اهتمامك بفريقنا! الله يخليك. عشان نعرف موقعك تحديداً، قولنا: **ماهي مهنتك؟** (مهندس أم مهندسة، تقني، أم عامل؟)`,
      4: `🏢 **ملف شركة ساند بوينت العالمية للمقاولات (SAND POINT GLOBAL)**:
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
• عضوية غرفة الغرف السعودية

🏆 **مشاريعنا**:
• أمانة المنطقة الشرقية
• شركة أرامكو
• الهيئة الملكية
• وزارة التعليم

📝 اكتب **5** للعودة للقائمة الرئيسية أو **0** للتواصل مباشرة...`,
      5: `📍 **بيانات التواصل - ساند بوينت العالمية**:

📍 العنوان: الدمام - المنطقة الشرقية - المملكة العربية السعودية
📞 الهاتف: +966 543120557
📱 واتساب: +966 543120557
📧 البريد الإلكتروني: info@sandpointglobal.com
🌐 الموقع الإلكتروني: www.sandpointglobal.com

⏰ ساعات العمل:
الأحد - الخميس: 7:30 ص - 3:30 م
الجمعة - السبت: مغلق

📝 اكتب **5** للعودة للقائمة الرئيسية أو **0** للتواصل مباشرة...`
    },
    prompts: {
      name: 'الاسم الكامل',
      phone: 'رقم الجوال',
      specialty: 'مجال التخصص',
      details: 'التفاصيل',
      profession: 'مهنتك',
      property_type: 'نوع العقار',
      area: 'مساحة العقار بالمتر المربع',
      district: 'الحي / المنطقة في الدمام',
      cv_files: 'ملف السيرة الذاتية (PDF)',
      work_files: 'صور أو فيديوهات من أعمال سابقة',
      company_profile: 'الملف التجاري (PDF أو صورة)',
      invalid_phone: '❌ رقم الجوال غير صحيح ياختي. الحين اكتب رقم سعويد صحيح مثل: 05XXXXXXXX أو +9665XXXXXXXX:',
      invalid_name: '❌ الاسم قصير جداً. الحين اكتب اسمك الكامل:',
      invalid_profession: '❌ يرجى تحديد مهنتك بدقة: مهندس، تقني، أم عامل؟',
      thank_you: 'الله يخليك! تواصلك مع فريقنا تم استلامه. بنراجع طلبك ونتواصل معاك قريب. 🌟',
      engineer_prompt: '✅ عشان يتم فرز طلبك والتواصل مع القسم المناسب، يرجى إرفاق السيرة الذاتية (PDF) الآن. أو اكتب **تم** للمتابعة بدون ملف.',
      worker_prompt: '✅ عشان نطلع على خبرتك ومهاراتك، يرجى إرفاق صور أو فيديوهات من أعمال سابقة. أو اكتب **تم** للمتابعة.'
    },
    summary: '✅ تم استلام طلبك بنجاح!\\n📋 البيانات المسجلة:\\n• الاسم: {name}\\n• الجوال: {phone}\\n• التفاصيل: {details}\\n\\n📞 هاتفنا: +966 543120557\\n🕐 بنتواصل معاك خلال 24 ساعة إن شاء الله.\\nشكراً لوثوقك بساند بوينت العالمية 🌟\\n\\n📝 اكتب **5** للعودة للقائمة الرئيسية أو **0** للتواصل مباشرة...',
    menuTitle: '📋 قائمة الخدمات - ساند بوينت العالمية',
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
          { title: '1. العربية 🇸🇦', description: 'اللهجة السعودية' },
          { title: '2. English 🇬🇧', description: 'English language' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'اردو زبان' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'বাংলা ভাষা' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिंदी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  en: {
    greeting: `Welcome to Sand Point Global Contracting (SAND POINT GLOBAL) - Dammam 🏗️
We are a leading Saudi contracting company serving the Eastern Province with top-quality construction services!
Please choose the service you need:
1️⃣ New Client - Request a quote or inquiry
2️⃣ Subcontractor - Partner with Sand Point
3️⃣ Job Seeker - Join our team
4️⃣ Company Profile - Learn more about us
5️⃣ Contact Info - How to reach us
📝 Enter the option number...`,
    options: {
      1: `New Client - We're happy to serve you!
To provide you with the best possible service, we need:
• Property type (residential, commercial, industrial, etc.)
• Property area in square meters
• District/neighborhood in Dammam
📝 Start with **property type**...`,
      2: `Subcontractor - Welcome to our partner network!
To register your company profile and work with us properly:
• Company profile (PDF or image)
• Your/company name
• Your specialization (Construction, Electrical, Plumbing, AC, etc.)
• Mobile number
📝 Start with **your/company name**...`,
      3: `Job Seeker - Thank you for your interest in joining us!
To route your application correctly, please tell us: **What is your profession?** (Engineer, Technician, or Worker)?`,
      4: `🏢 **Company Profile - Sand Point Global Contracting (SAND POINT GLOBAL)**:
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

📝 Enter **5** for main menu or **0** for direct contact...`,
      5: `📍 **Contact Information - Sand Point Global**:

📍 Address: Dammam - Eastern Province - Saudi Arabia
📞 Phone: +966 543120557
📱 WhatsApp: +966 543120557
📧 Email: info@sandpointglobal.com
🌐 Website: www.sandpointglobal.com

⏰ Working Hours:
Sunday - Thursday: 7:30 AM - 3:30 PM
Friday - Saturday: Closed

📝 Enter **5** for main menu or **0** for direct contact...`
    },
    prompts: {
      name: 'Full Name',
      phone: 'Mobile Number',
      specialty: 'Specialization',
      details: 'Details',
      profession: 'Your Profession',
      property_type: 'Property Type',
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
    summary: '✅ Your request has been received successfully!\n📋 Registered details:\n• Name: {name}\n• Mobile: {phone}\n• Details: {details}\n\n📞 Our phone: +966 543120557\n🕐 We will contact you within 24 hours.\nThank you for trusting Sand Point Global 🌟\n\n📝 Enter **5** for main menu or **0** for direct contact...',
    menuTitle: '📋 Service Menu - Sand Point Global',
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
          { title: '1. العربية 🇸🇦', description: 'Saudi dialect' },
          { title: '2. English 🇬🇧', description: 'English language' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'اردو زبان' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'বাংলা ভাষা' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिंदी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  ur: {
    greeting: `سینڈ پوائنٹ گلوبل کانٹریکٹنگ (SAND POINT GLOBAL) - جلیل میں سواگت ہے 🏗️
ہم ایک سعودی کنٹریکٹر ہیں جو مشرقی علاقائی کی تعمیر کی کوشش کرتے ہیں!
براہ کرم درج ذیل سروسز میں سے ایک منتخب کریں:
1️⃣ نیو کلائنٹ - قیمت یا استفسار
2️⃣ سب کونٹراکٹر - سینڈ پوائنٹ کے ساتھ شراکت
3️⃣ جاب سیکر - ہماری ٹیم میں شامل ہوں
4️⃣ کمپنی پروفائل - ہمارے بارے میں مزید جانیں
5️⃣ رابطہ معلومات - ہم سے کیسے رابطے میں رہیں
📝 نمبر لکھیں...`,
    options: {
      1: `نیو کلائنٹ - ہم آپ کی خدمت کرنا چاہتے ہیں!
بہترین سروس کے لیے ہم ضرورت رکھتے ہیں:
• پراپرٹی کی قسم (ریزیڈینشل، کامرشل، انڈسٹریشل، وغیرہ)
• پراپرٹی کریویچر مربع میٹر میں
• ڈسٹرکٹ/پڑوس میں
📝 **پراپرٹی کی قسم** لکھیں...`,
      2: `سب کونٹراکٹر - ہمارے ساتھ شراکت کے نیٹ ورک میں خوش آمدید!
اپنا کمپنی پروفائل رجسٹر کرنا اور ہم سے ملنا ہے تو:
• کمپنی پروفائل (PDF یا تصویر)
• آپ کا/کمپنی کا نام
• آپ کی تخصص (کنکریشن، الیکٹریکل، پلامبر، ایسی اے سی، وغیرہ)
• موبائل نمبر
📝 **آپ کا/کمپنی کا نام** لکھیں...`,
      3: `جاب سیکر - ہماری ٹیم میں شامل ہونے کے لئے آپ کے دلچسپی کے لئے شکریہ!
آپ کی درخواست کو درست انداز میں رواج کے لئے مہینے کریں: **آپ کی پیشہ وری کیا ہے؟** (اینجینئر، ٹیکنیشین، یا کارگر؟)`,
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

📝 مرکزی مینو کے لیے **5** لکھیں یا سیمیل رابطے کیلئے **0** لکھیں...`,
      5: `📍 **رابطہ معلومات - سینڈ پوائنٹ گلوبل**:

📍 پتہ: الخلیج - مشرقی علاقہ - سعودی عرب
📞 فون: +966 543120557
📱 واٹس ایپ: +966 543120557
📧 ای میل: info@sandpointglobal.com
🌐 ویب سائیٹ: www.sandpointglobal.com

⏰ کام کے اوقات:
اتوار - ہفتہ 7:30 صبح - 3:30 بجرے دوپہر
ہفتہ - شنی وار: بند

📝 مرکزی مینو کے لیے **5** لکھیں یا سیمیل رابطے کیلئے **0** لکچیں...`
    },
    prompts: {
      name: 'مکمل نام',
      phone: 'موبائل نمبر',
      specialty: 'تخصص',
      details: 'تفصیلات',
      profession: 'آپ کی پیشہ وری',
      property_type: 'پراپرٹی کی قسم',
      area: 'کشتی (سکوایر میٹر)',
      district: 'ڈسٹرکٹ/مقام قرآت میں',
      cv_files: 'سی وی فائل (PDF)',
      work_files: 'کام کی تصاویر/ویڈیو',
      company_profile: 'کمپنی پروفائل (PDF یا تصویر)',
      invalid_phone: '❌ غلط فون نمبر۔ براہ کرم ایک درست سعوی نمبر لکھیں (جیسے: 05XXXXXXXX یا +9665XXXXXXXX):',
      invalid_name: '❌ نام بہت مختصر ہے۔ براہ کرم اپنا مکمل نام لکھیں:',
      invalid_profession: '❌ براہ کرم اپنی پیشہ وری واضح بنائیں: انجینئر، ٹیکنیشین، یا مجرور؟',
      thank_you: 'ہماری ٹیم سے رابطے کو شکریہ! ہم نے آپ کے پیغام کو موصول کیا ہے اور ہم جلد از جلد واپس آئیں گے۔ 🌟',
      engineer_prompt: '✅ آپ کی درخواست ہمارے انجینئری واحد کے لیے موصول ہوگئی۔ براہ کرم اپنا CV (PDF) ایٹیچ کریں۔ یا بغیر فائل کے آگے بڑھنے کے لئے **done** لکھیں۔',
      worker_prompt: '✅ آپ کی صلاحیت کے لئے براہ کرم اپنے پچھلے کام کی تصاویر یا ویڈیو ایڈیٹ کریں۔ یا بغیر فائل کے آگے بڑھنے کے لئے **done** لکھیں۔'
    },
    summary: `✅ آپ کا درخواست برائے موصول!\n📋 درج شدہ تفصیلات:\n• نام: {name}\n• موبائل: {phone}\n• تفصیلات: {details}\n\n📞 ہمارا فون: +966 543120557\n🕐 ہم 24 گھنٹے کے اندر آپ سے رابطے کریں گے۔\nسینڈ پوائنٹ گلوبل پر بھروسے کے لئے شکریہ 🌟\n\n📝 مرکزی مینو کے لیے **5** لکھیں یا سیمیل رابطے کیلئے **0** لکچیں...`,
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
          { title: '1. العربية 🇸🇦', description: 'ساؤڈی ڈیئلیکٹ' },
          { title: '2. English 🇬🇧', description: 'انگریزی زبان' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'اردو زبان' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'বাংলা ভাষা' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिंदी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'Tagalog na wika' }
        ]
      }
    ]
  },
  ne: {
    greeting: `स्यान्ड पोइंट ग्लोबल कन्ट्राक्टिङ (SAND POINT GLOBAL) - दम्मममा स्वागत छ 🏗️
हामी पूर्वी प्रांवमा एक अग्रणी सउदी निर्माण कम्पनी छौं!
कृपया तलबाट सेवा छनोट गर्नुहोस्:
1️⃣ नयाँ ग्राहक - मूल्य अनुमान वा प्रश्न
2️⃣ सबकन्ट्राक्टर - स्यान्ड पोइंटसँग साझेदारी
3️⃣ रोजगारीको खोजी - हाम्रो टोलीमा जोडिनुहोस्
4️⃣ कम्पनी प्रोफाइल - हामीबारे थप जान्नुहोस्
5️⃣ सम्पर्क जानकारी - हामीसँग कसरी सम्पर्क गर्ने
📝 नम्बर लेख्नुहोस् (1-5)...`,
    options: {
      1: `नयाँ ग्राहक - हामी तपाईंको सेवा गर्न खुश हुनुहुन्छ!
सर्वोत्तम सेवा प्रदान गर्न हामी आवश्यक छ:
• सम्पत्ति को प्रकार (बासिन्दा, व्यावसायिक, औद्योगिक आदि)
• सम्पत्ति क्षेत्रफल वर्ग मिटरमा
• दम्ममको डिस्ट्रिक्ट/पड़ोस
📝 **सम्पत्ति का प्रकार** लेख्नुहोस्...`,
      2: `सबकन्ट्राक्टर - हाम्रो साझेदारी नेटवर्कमा स्वागत छ!
कम्पनीको प्रोफाइल दर्ता गर्न र हामीलाई कसरी काम गर्न चाहनुहुन्छ:
• कम्पनी प्रोफाइल (PDF वा चित्र)
• तपाईंको/कम्पनीको नाम
• तपाईंको विशेषज्ञता (निर्माण, बिद्युत, प्लम्बिङ, एसी, अन्य)
• मोबाइल नम्बर
📝 **तपाईंको/कम्पनीको नाम** लेख्नुहोस्...`,
      3: `रोजगारीको खोजी - हाम्रो टोलीमा जोडिन चाहनुभएकोमा धन्यवाद!
तपाईंको आवेदनलाई सही रूपमा मार्गित गर्न, हामीलाई बताउनुहोस्: **तपाईंको पेशा के हो?** (इन्जिनियर, टेक्निशियन, वा मजदुर)?`,
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

📝 मुख्य मेनुमा फर्कन **5** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`,
      5: `📍 **सम्पर्क जानकारी - स्यान्ड पोइंट ग्लोबल**:

📍 ठेगाना: दम्मम - पूर्वी प्रांव - सउदी अरब
📞 फोन: +966 543120557
📱 व्हाट्सऐप: +966 543120557
📧 ईमेल: info@sandpointglobal.com
🌐 वेबसाइट: www.sandpointglobal.com

⏰ कामको समय:
आइतवार - बिहीबार 7:30 बिही - 3:30 बिही
शुक्र - शनि: बन्द

📝 मुख्य मेनुमा फर्कन **5** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`
    },
    prompts: {
      name: 'पूरा नाम',
      phone: 'मोबाइल नम्बर',
      specialty: 'विशेषज्ञता क्षेत्र',
      details: 'विवरण',
      profession: 'तपाईंको पेशा',
      property_type: 'सम्पत्ति को प्रकार',
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
    summary: `✅ तपाईंको अनुरोध सफलतापूर्वक प्राप्त भयो!\n📋 दर्ता विवरण:\n• नाम: {name}\n• मोबाइल: {phone}\n• विवरण: {details}\n\n📞 हाम्रो फोन: +966 543120557\n🕐 हामीले 24 घण्टाभित्र तपाईंसँग सम्पर्क गर्नेछौं।\nस्यान्ड पोइंट ग्लोबलमा विश्वास गर्नुभएकोमा धन्यवाद 🌟\n\n📝 मुख्य मेनुमा फर्कन **5** लेख्नुहोस् वा सम्पर्क **0** लिख्नुहोस्...`,
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
          { title: '1. العربية 🇸🇦', description: 'साउदी डिऐलेक्ट' },
          { title: '2. English 🇬🇧', description: 'इंग्लिश भाषा' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'उर्दु भाषा' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'बंग्ला भाषा' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिन्दी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'ट्यागालग भाषा' }
        ]
      }
    ]
  },
  bn: {
    greeting: `স্যান্ড পয়েন্ট গ্লোবাল কন্ট্রাক্টিং (SAND POINT GLOBAL) - ঢাকামে স্বাগতম 🏗️
আমরা পূর্বীয় প্রান্তে একটি অগ্রণী সৌদি ঠিঠিকল কোম্পানি।
নিচের সেবাগুলি থেকে একটি বেছে নিন:
1️⃣ নতুন গ্রাহক - মূল্য আঁচন বা প্রশ্ন
2️⃣ সাবকন্ট্রাক্টর - স্যান্ড পয়েন্টের সাথে অংশীদারশী
3️⃣ চাকরীর অনুসন্ধান - আমাদের দলে যুক্ত হন
4️⃣ কোম্পানি প্রোফাইল - আমাদের সম্পর্কে আরও জানুন
5️⃣ যোগাযোগের তথ্য - আমরা কীভাবে যোগাযোগ করব
📝 বিকল্প নম্বর লিখুন (1-5)...`,
    options: {
      1: `নতুন গ্রাহক - আমরা আপনার সেবা করতে আনন্দিত!
সর্বোত্তম সেবা প্রদানের জন্য আমরা প্রয়োজন:
• সম্পত্তির ধরন (বাসস্থান, বাণিজ্যিক, ঔদ্যোগিক ইত্যাদি)
• সম্পত্তির ক্ষেত্রফল বর্গ মিটারে
• গাঢ়াম (ঢাকাম) এর জেলা/পড়োস
📝 **সম্পত্তির ধরন** লিখে শুরু করুন...`,
      2: `সাবকন্ট্রাক্টর - আমাদের অংশীদার নেটওয়ার্কে স্বাগতম!
কোম্পানি প্রোফাইল রেজিস্টার করতে এবং আমাদের সাথে কাজ করতে:
• কোম্পানি প্রোফাইল (PDF বা ছবি)
• আপনার/কোম্পানির নাম
• বিশেষজ্ঞতা (নির্মাণ, বৈদ্যুতিক, প্লাম্বিং, এসি, অন্যান্য)
• মোবাইল নম্বর
📝 **আপনার/কোম্পানির নাম** লিখে শুরু করুন...`,
      3: `চাকরীর অনুসন্ধান - আমাদের দলে যুক্ত হওয়ার আগ্রহের জন্য ধন্যবাদ!
আপনার আবেদন সঠিকভাবে পাথরতে আমাকে বলুন: **আপনার পেশা কী?** (ইঞ্জিনিয়ার, টেকনিসিয়ান, বা মজুর)?`,
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

📝 মূল মেনুতে ফিরতি **5** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`,
      5: `📍 **যোগাযোগের তথ্য - স্যান্ড পয়েন্ট গ্লোবাল**:

📍 ঠিঠি: ঢাকা - পূর্বীয় প্রান্ত - সৌদি আরব
📞 ফোন: +966 543120557
📱 হোয়াটসঅ্যাপ: +966 543120557
📧 ইমেল: info@sandpointglobal.com
🌐 ওয়েবসাইট: www.sandpointglobal.com

⏰ কাজের সময়:
রববার - বৃহস্পতি 7:30 AM - 3:30 PM
শুক্রবার - শনিবার: বন্দ

📝 মূল মেনুতে ফিরতি **5** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`
    },
    prompts: {
      name: 'পূর্ণ নাম',
      phone: 'মোবাইল নম্বর',
      specialty: 'বিশেষজ্ঞতা',
      details: 'বিবরণী',
      profession: 'আপনার পেশা',
      property_type: 'সম্পত্তির ধরন',
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
    summary: `✅ আপনার অনুরোধটি সফলভাবে গৃহীত হয়েছে!\n📋 রেজিস্টার করা বিবরণী:\n• নাম: {name}\n• মোবাইল: {phone}\n• বিবরণী: {details}\n\n📞 আমাদের ফোন: +966 543120557\n🕐 আমরা 24 ঘণ্টার মধ্যে আপনার সাথে যুক্ত হব।\nস্যান্ড পয়েন্ট গ্লোবাল-এ আপনার বিশ্বাসের জন্য ধন্যবাদ 🌟\n\n📝 মূল মেনুতে ফিরতি **5** লিখুন বা সরাসরি যোগাযোগ **0** লিখুন...`,
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
          { title: '1. العربية 🇸🇦', description: 'সৌদি ডিয়ালেক্ট' },
          { title: '2. English 🇬🇧', description: 'ইংরেজি ভাষা' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'উর্দু ভাষা' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'নেপালি ভাষা' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'বাংলা ভাষা' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'হিন্দি ভাষা' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'ট্যাগালog ভাষা' }
        ]
      }
    ]
  },
  hi: {
    greeting: `सैंड पॉइंट ग्लोबल कंट्राक्टिंग (SAND POINT GLOBAL) - दम्मम में स्वागत है 🏗️
हम ईस्टर्न प्रांट में एक अग्रणी सउदी निर्माण कंपनी हैं!
कृपया नीचे से सेवा चुनें:
1️⃣ नए ग्राहक - कीमत अनुमान या प्रश्न पूछें
2️⃣ सबकंट्राक्टर - सैंड पॉइंट के साथ साझेदारी
3️⃣ नौकरी की तलाश - अपना CV भेजें
4️⃣ कंपनी प्रोफाइल - हमांरे बारे में और जानें
5️⃣ संपर्क जानकारी - हमारा पता, फोन और काम का समय
📝 विकल्प नंबर लिखें (1-5)...`,
    options: {
      1: `नए ग्राहक - हम आपकी सेवा करने के लिए खुश हैं!
सर्वश्रेष्ठ सेवा देने के लिए हमें चाहिए:
• सम्पत्ति का प्रकार (बाग़मती, व्यावसायिक, औद्योगिक आदि)
• सम्पत्ति का क्षेत्रफल वर्ग मीटर में
• दम्मम का डिस्ट्रिक्ट/पड़ोस
📝 **सम्पत्ति के प्रकार** से शुरू करें...`,
      2: `सबकंट्राक्टर - हमारे साझेदार नेटवर्क में स्वागत है!
अपनी कंपनी प्रोफाइल रजिस्टर करने और हमके साथ काम करने के लिए:
• कंपनी प्रोफाइल (PDF या छवि)
• आपका/कंपनी का नाम
• आपका विशेषज्ञता (निर्माण, बिजली, प्लंबिंग, एसी, अन्य)
• मोबाइल नंबर
📝 **आपका/कंपनी का नाम** से शुरू करें...`,
      3: `नौकरी की तलाश - हमारी टीम में जुड़ने के लिए धन्यवाद!
अपने आवेदन को सही ढंग से मार्गदर्शित करने के लिए, बताइए: **आपका पेशा क्या है?** (इंजीनियर, टेक्नीशियन, या मजदूर)?`,
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

📝 मुख्य मेन्यू में वापसी हेतु **5** लिखें या संपर्क **0** लिखें...`,
      5: `📍 **संपर्क जानकारी - सैंड पॉइंट ग्लोबल**:

📍 पता: दम्मम - पूर्वी प्रांट - सउदी अरब
📞 फ़ोन: +966 543120557
📱 व्हाट्सऐप: +966 543120557
📧 ईमेल: info@sandpointglobal.com
🌐 वेबसाइट: www.sandpointglobal.com

⏰ काम का समय:
रवि - गुरु 7:30 AM - 3:30 PM
शुक्र - शनि: बंद

📝 मुख्य मेन्यू में वापसी हेतु **5** लिखें या संपर्क **0** लिखें...`
    },
    prompts: {
      name: 'पूरा नाम',
      phone: 'मोबाइल नंबर',
      specialty: 'विशेषज्ञता क्षेत्र',
      details: 'विवरण',
      profession: 'आपका पेशा',
      property_type: 'संपत्ति का प्रकार',
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
    summary: `✅ आपका अनुरोध सफलतापूर्वक प्राप्त हो गया!\n📋 दर्ज विवरण:\n• नाम: {name}\n• मोबाइल: {phone}\n• विवरण: {details}\n\n📞 हमारा फ़ोन: +966 543120557\n🕐 हम 24 घंटे के भीतर आपसे संपर्क करेंगे।\nसैंड पॉइंट ग्लोबल पर भरोसेमंद होने के लिए धन्यवाद 🌟\n\n📝 मुख्य मेन्यू में वापसी हेतु **5** लिखें या संपर्क **0** लिखें...`,
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
          { title: '1. العربية 🇸🇦', description: 'साउदी डायलैक्ट' },
          { title: '2. English 🇬🇧', description: 'इंग्लिश भाषा' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'उर्दु भाषा' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'बंग्ला भाषा' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिंदी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'टैगालॉग भाषा' }
        ]
      }
    ]
  },
  tl: {
    greeting: `Tugon sa Sand Point Global Contracting (SAND POINT GLOBAL) - Dammam 🏗️
Kami ay isang naileading na Saudi kontratista sa Eastern Province!
Pumili ng serbisyo mula sa listahan sa ibaba:
1️⃣ Bagong Kliyente - Hilingin ang presyo o query
2️⃣ Subcontractor - Maging partner ng Sand Point
3️⃣ Job Seeker - Sumali sa aming koponan
4️⃣ Kumpanya na Profile - Alamin pa tungkol sa amin
5️⃣ Contact Info - Paano mo kaming makikinan
📝 Ilagay ang numero (1-5)...`,
    options: {
      1: `Bagong Kliyente - Natutuwa kaming magsilbi sa'yo!
Para sa pinakamagandang serbisyo, kailangan namin:
• Uri ng property (tirahan, commercial, industrial, iba pa)
• Sukat property sa square meters
• Distrito/Kapitbahay sa Dammam
📝 Magsimula sa **uri ng property**...`,
      2: `Subcontractor - Maligayang pagdating sa aming partner network!
Upang mag-register at magsama-sama sa amin:
• Kumpanya profile (PDF o larawan)
• Pangalan mo/kumpanya
• Espesyalisasyon mo (Konstruksyon, Elektura, Plomero, AC, iba pa)
• Mobile number
📝 Magsimula sa **pangalan mo/kumpanya**...`,
      3: `Job Seeker - Salamat sa iyong interes!
Upang maupo ang iyong application nang tama, sabihin mo: **Ano ang iyong propesyon?** (Inhenyero, Tekniko, o Manggagawa)?`,
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

📝 I-to **5** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`,
      5: `📍 **Contact Information - Sand Point Global**:

📍 Tugon: Dammam - Eastern Province - Saudi Arabia
📞 Telepono: +966 543120557
📱 WhatsApp: +966 543120557
📧 Email: info@sandpointglobal.com
🌐 Website: www.sandpointglobal.com

⏰ Oras ng trabaho:
Linggo - Huwebes 7:30 AM - 3:30 PM
Biyernes - Sabado: Sarado

📝 I-to **5** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`
    },
    prompts: {
      name: 'Buong Pangalan',
      phone: 'Mobile Number',
      specialty: 'Espesyalisasyon',
      details: 'Detalye',
      profession: 'Iyong propesyon',
      property_type: 'Uri ng property',
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
    summary: `✅ Natanggap ang iyong kahilingan!\n📋 Detalye:\n• Pangalan: {name}\n• Mobile: {phone}\n• Detalye: {details}\n\n📞 Telepono namin: +966 543120557\n🕐 Makikipag-ugnayan kami sa loob ng 24 na oras.\nSalamat sa tiwala sa Sand Point Global 🌟\n\n📝 I-to **5** para sa pangunahing menu o **0** para sa direkta makikipag-ugnayan...`,
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
          { title: '1. العربية 🇸🇦', description: 'Saudi dialect' },
          { title: '2. English 🇬🇧', description: 'English language' },
          { title: '3. اردو (Urdu) 🇵🇰', description: 'اردو زبان' },
          { title: '4. नेपाली (Nepali) 🇳🇵', description: 'नेपाली भाषा' },
          { title: '5. বাংলা (Bengali) 🇧🇩', description: 'বাংলা ভাষা' },
          { title: '6. हिंदी (Hindi) 🇮🇳', description: 'हिंदी भाषा' },
          { title: '7. Tagalog (Filipino) 🇵🇭', description: 'Tagalog na wika' }
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

const LANGUAGE_SELECTION = `Welcome to Sand Point Global Contracting 🏗️
الرجاء اختيار لغة التواصل / Please choose your language:
1. العربية 🇸🇦
2. English 🇬🇧
3. اردو (Urdu) 🇵🇰
4. नेपाली (Nepali) 🇳🇵
5. বাংলা (Bengali) 🇧🇩
6. हिंदी (Hindi) 🇮🇳
7. Tagalog (Filipino) 🇵🇭`;

async function sendListMessage(sock, userId, text, title, sections) {
  try {
    await sock.sendPresenceUpdate('composing', userId);
  } catch (e) {}
  await humanDelay();
  
  const listMessage = {
    text,
    footer: 'Sand Point Global - اختر من القائمة أدناه / Choose from the list below',
    title,
    buttonText: 'عرض القائمة / View List',
    sections
  };
  
  await sock.sendMessage(userId, listMessage);
}

async function sendLanguageList(sock, userId) {
  try {
    await sock.sendPresenceUpdate('composing', userId);
  } catch (e) {}
  await humanDelay();
  
  const sections = LANG_MESSAGES.ar.languageList;
  const listMessage = {
    text: LANGUAGE_SELECTION,
    footer: 'Sand Point Global - اختر لغتك / Choose your language',
    title: '🌍 اختر اللغة / Choose Language',
    buttonText: 'اختر اللغة / Choose Language',
    sections
  };
  
  await sock.sendMessage(userId, listMessage);
}

async function sendProfessionList(sock, userId, t, userState) {
  try {
    await sock.sendPresenceUpdate('composing', userId);
  } catch (e) {}
  await humanDelay();
  
  const lang = userState.language || 'en';
  const sections = [{
    title: lang === 'ar' ? 'المهن / Professions' : 'Professions',
    rows: [
      { title: lang === 'ar' ? '👨‍💼 مهندس' : '👨‍💼 Engineer', description: lang === 'ar' ? 'مهندس مدنى أو ميكانيكي' : 'Civil or Mechanical Engineer' },
      { title: lang === 'ar' ? '🔧 تقني' : '🔧 Technician', description: lang === 'ar' ? 'تقني مختبر' : 'Lab Technician or Supervisor' },
      { title: lang === 'ar' ? '👷 عامل' : '👷 Worker', description: lang === 'ar' ? 'عامل بناء أو نجار' : 'Construction Worker or Carpenter' }
    ]
  }];
  
  const listMessage = {
    text: t.options['3'],
    footer: 'Sand Point Global - اختر مهنتك / Choose your profession',
    title: '💼 ' + (lang === 'ar' ? 'ماهي مهنتك؟' : 'What is your profession?'),
    buttonText: lang === 'ar' ? 'اختر المهنة' : 'Choose Profession',
    sections
  };
  
  await sock.sendMessage(userId, listMessage);
}

async function handleMessage(sock, m) {
  if (!m.message) return;
  
  const userId = m.key.remoteJid;
  const isGroup = userId.endsWith('@g.us');
  
  if (isGroup) return;
  
  const userState = getUserState(userId);
  const messageText = m.message.conversation || m.message.extendedTextMessage?.text || '';
  const text = messageText.trim();
  
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
  
  if (text === '0') {
    const thankYouMsg = LANG_MESSAGES[userState.language || 'en'].prompts.thank_you;
    await sendMsg(thankYouMsg);
    resetUserState(userId);
    return;
  }
  
  if (text === '/start' || text === 'restart' || text.toLowerCase() === 'cancel') {
    resetUserState(userId);
    await sendLanguageList(sock, userId);
    return;
  }
  
  if (hasAttachment) {
    const lang2 = userState.language || 'en';
    const t2 = LANG_MESSAGES[lang2];
    if (userState.step === 'collect_details' && ['1', '2', '3'].includes(userState.category)) {
      await sendMsg(`✅ ${lang2 === 'ar' ? 'تم استلام ملفكم بنجاح' : 'File received successfully'}! ${attachmentInfo.fileName}\n\n${lang2 === 'ar' ? '📝 اكتبوا' : '📝 Type'} **done** ${lang2 === 'ar' ? 'للانهاء' : 'to finish'}...`);
      return;
    }
  }
  
  if (!text && !hasAttachment) return;
  
  if (userState.step === 'language') {
    if (['1', '2', '3', '4', '5', '6', '7'].includes(text)) {
      const langCode = LANG_CODES[text];
      updateUserState(userId, { language: langCode, step: 'greeting', category: null });
      await sendMsg(LANG_MESSAGES[langCode].greeting);
      const tLang = LANG_MESSAGES[langCode];
      await sendListMessage(sock, userId, tLang.greeting, tLang.menuTitle, tLang.menuOptions);
    } else {
      await sendLanguageList(sock, userId);
    }
    return;
  }
  
  const lang = userState.language || 'en';
  const t = LANG_MESSAGES[lang];
  
  if (text === '5' && userState.step !== 'greeting') {
    await sendMsg(t.greeting);
    await sendListMessage(sock, userId, t.greeting, t.menuTitle, t.menuOptions);
    updateUserState(userId, { step: 'greeting' });
    return;
  }
  
  if (userState.step === 'greeting') {
    if (['1', '2', '3', '4', '5'].includes(text)) {
      if (text === '4' || text === '5') {
        await sendMsg(t.options[text]);
        await sendListMessage(sock, userId, t.greeting, t.menuTitle, t.menuOptions);
        return;
      }
      if (text === '3') {
        updateUserState(userId, { step: 'collect_profession', category: text });
        await sendProfessionList(sock, userId, t, userState);
        return;
      } else {
        updateUserState(userId, { step: 'collect_name', category: text });
      }
      await sendMsg(t.options[text]);
    } else {
      await sendListMessage(sock, userId, t.greeting, t.menuTitle, t.menuOptions);
    }
    return;
  }
  
  if (userState.step === 'collect_profession') {
    const lowerText = text.toLowerCase();
    let profession = null;
    
    // Check for list message responses (row titles)
    if (lowerText.includes('engineer') || lowerText.includes('مهندس') || lowerText.includes('इन्जिनियर') || lowerText.includes('ইঞ্জিনিয়ার')) {
      profession = 'engineer';
    } else if (lowerText.includes('technician') || lowerText.includes('تقني') || lowerText.includes('टेक्निशियन') || lowerText.includes('টেকনিসিয়ান')) {
      profession = 'technician';
    } else if (lowerText.includes('worker') || lowerText.includes('عامل') || lowerText.includes('مزدور') || lowerText.includes('मजदुर') || lowerText.includes('মজুর') || lowerText.includes('trabaho') || lowerText.includes('manggagawa')) {
      profession = 'worker';
    }
    
    if (profession) {
      updateUserState(userId, { profession: profession, step: 'collect_name' });
      await sendMsg(`✅ ${t.prompts.thank_you}\n${lang === 'ar' ? 'الآن نحتاج' : lang === 'en' ? 'Now we need' : lang === 'tl' ? 'Ngayon kailangan namin' : 'अब हम चाहिए'}\n• ${t.prompts.name}\n• ${t.prompts.phone}\n📝 ${lang === 'ar' ? 'ابدأ بـ' : 'Start with'} **${t.prompts.name}**...`);
    } else {
      const professionOptions = lang === 'ar' ? '(مهندس، تقني، أم عامل)' : '(Engineer, Technician, or Worker)';
      await sendMsg('❌ ' + t.prompts.invalid_profession + ' ' + professionOptions + '...');
    }
    return;
  }
  
  if (userState.step === 'collect_name') {
    if (text.length < 2) {
      await sendMsg('❌ ' + t.prompts.invalid_name);
      return;
    }
    updateUserState(userId, { name: text, step: 'collect_phone' });
    await sendMsg(`[${t.prompts.thank_you}] ${lang === 'ar' ? 'الآن' : 'Now'} **${t.prompts.phone}** (${lang === 'ar' ? 'مثال: 05XXXXXXXX' : 'e.g., 05XXXXXXXX'}):`);
    return;
  }
  
  if (userState.step === 'collect_phone') {
    const phoneRegex = /^(05|\+9665|9665)[0-9]{8}$/;
    const cleanPhone = text.replace(/[\s-]/g, '');
    if (!phoneRegex.test(cleanPhone)) {
      await sendMsg('❌ ' + t.prompts.invalid_phone);
      return;
    }
    updateUserState(userId, { phone: cleanPhone, step: 'collect_details' });
    
    if (userState.category === '1') {
      await sendMsg(`✅ ${lang === 'ar' ? 'عشان نكمل الفلوس، نحتاج' : '✅ To proceed, we need'}:\n• ${t.prompts.property_type}\n• ${t.prompts.area}\n• ${t.prompts.district}\n📝 ${lang === 'ar' ? 'ابدأ بـ' : 'Start with'} **${t.prompts.property_type}**...`);
    } else if (userState.category === '2') {
      await sendMsg(`✅ ${lang === 'ar' ? 'عشان نرفع ملفك لقسم المشاريع،' : '✅ To register your profile,'} ${lang === 'ar' ? 'نحتاج' : 'we need'}:\n• ${t.prompts.company_profile}\n• ${t.prompts.specialty}\n📝 ${lang === 'ar' ? 'ابدأ بـ' : 'Start with'} **${t.prompts.specialty}** أو أرفق الملف الآن...`);
    } else if (userState.category === '3') {
      if (userState.profession === 'engineer' || userState.profession === 'technician') {
        await sendMsg(`✅ ${t.prompts.engineer_prompt}`);
      } else {
        await sendMsg(`✅ ${t.prompts.worker_prompt}`);
      }
    }
    return;
  }
  
  if (userState.step === 'collect_details') {
    if (userState.category === '1') {
      if (text.toLowerCase() === 'done' || text.toLowerCase() === 'finish' || text === 'تم') {
        updateUserState(userId, { step: 'complete' });
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.details || text);
        await sendMsg(summary);
      } else {
        updateUserState(userId, { details: text });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? '📝 اكتب' : '📝 Type'} **done** ${lang === 'ar' ? 'للانهاء' : 'to finish'}...`);
      }
    } else if (userState.category === '2') {
      if (text.toLowerCase() === 'done' || text.toLowerCase() === 'finish' || text === 'تم') {
        updateUserState(userId, { step: 'complete' });
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.specialty);
        await sendMsg(summary);
      } else {
        updateUserState(userId, { specialty: text });
        await sendMsg(`✅ ${t.prompts.specialty}: ${text}\n\n${lang === 'ar' ? '✅ عشان نرفع ملفك،' : '✅ To upload your file,'} ${lang === 'ar' ? 'أرفق الملف الآن' : 'attach it now'} ${lang === 'ar' ? 'أو اكتب **تم**' : 'or type **done**'}...`);
      }
    } else if (userState.category === '3') {
      if (text.toLowerCase() === 'done' || text.toLowerCase() === 'finish') {
        updateUserState(userId, { step: 'complete' });
        const summary = t.summary
          .replace('{name}', userState.name)
          .replace('{phone}', userState.phone)
          .replace('{details}', userState.profession);
        await sendMsg(summary);
      } else {
        updateUserState(userId, { details: text });
        await sendMsg(`✅ ${lang === 'ar' ? 'تم التسجيل' : 'Recorded'}: ${text}\n\n${lang === 'ar' ? '📝 اكتب' : '📝 Type'} **done** ${lang === 'ar' ? 'للانهاء' : 'to finish'}...`);
      }
    }
    return;
  }
  
  if (userState.step === 'complete') {
    await sendMsg(LANGUAGE_SELECTION);
    resetUserState(userId);
    return;
  }
  
  await sendMsg(LANGUAGE_SELECTION);
  resetUserState(userId);
}

let currentQrData = null;
let pairingAttempted = false;

async function connectToWhatsApp() {
  try {
    console.log('\n🔄 Starting WhatsApp connection...');

    const { state, saveCreds } = await useMultiFileAuthState(join(__dirname, 'auth_info'));

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log("Baileys version: " + version.join(".") + " - Latest: " + isLatest);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['SAND POINT Bot', 'Safari', '1.0.0']
    });

    if (!pairingAttempted) {
      pairingAttempted = true;
      const PHONE_NUMBER = '+966543120557';
      console.log('\n📱 Requesting pairing code for:', PHONE_NUMBER);
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER.replace(/\D/g, ''));
        console.log('\n🔐 ============================================');
        console.log('🔑 PAIRING CODE:', code);
        console.log('   Enter this code on your phone to connect');
        console.log('🔐 ============================================\n');
      } catch (err) {
        console.log('\n❌ Pairing code failed:', err.message);
        console.log('   Falling back to QR code mode...\n');
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrImageDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: '#000', light: '#fff' }
          });
          currentQrData = qrImageDataUrl;
          console.log('\n📱 Open QR scanner at: ' + (process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT) + '/qr\n');
        } catch (e) {
          console.log('\n❌ QR generation error:', e.message);
        }
      }

      if (connection === 'open') {
        console.log('\n✅ Connected to WhatsApp!');
        console.log('🤖 Bot ready (7 languages + anti-ban protection)...\n');
        currentQrData = null;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('\n❌ Disconnected:', lastDisconnect?.error?.message);

        if (!shouldReconnect || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.connectionFailure) {
          console.log('🗑️  Cleaning corrupted session files...');
          try {
            rmSync(join(__dirname, 'auth_info'), { recursive: true, force: true });
            console.log('✅ auth_info cleared');
          } catch (cleanupErr) {
            console.log('⚠️ Cleanup error:', cleanupErr.message);
          }

          if (pairingAttempted) {
            console.log('🔄 Restarting with fresh session for QR fallback...\n');
            pairingAttempted = false;
            setTimeout(connectToWhatsApp, 2000);
          }
        } else if (shouldReconnect) {
          console.log('🔄 Reconnecting...\n');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('🔐 Logged out. Clearing session and retrying...\n');
          pairingAttempted = false;
          setTimeout(connectToWhatsApp, 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        if (!m.key.fromMe && m.message) {
          await handleMessage(sock, m);
        }
      }
    });

    return sock;
  } catch (err) {
    console.error('\n💥 Connection error:', err.message);
    console.log('🔄 Retrying in 5 seconds...\n');
    setTimeout(connectToWhatsApp, 5000);
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
  .container { max-width: 500px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  h1 { color: #25D36E; font-size: 24px; margin-bottom: 20px; }
  .qr-code { margin: 20px auto; display: flex; justify-content: center; }
  .instructions { margin-top: 20px; color: #555; font-size: 16px; line-height: 1.6; }
  .scan-icon { font-size: 24px; }
</style>
</head>
<body>
  <div class="container">
    <h1>SAND POINT GLOBAL 🏗️</h1>
    <div class="qr-code">
      <img src="${currentQrData}" alt="WhatsApp QR Code" style="max-width:100%; height:auto;" />
    </div>
    <div class="instructions">
      <div class="scan-icon">📱</div>
      <p><strong>Scan this QR code with WhatsApp</strong></p>
      <p>1. Open WhatsApp on your phone</p>
      <p>2. Go to Settings → WhatsApp Web/Desktop</p>
      <p>3. Tap "Scan QR Code" and scan this code</p>
    </div>
  </div>
</body>
</html>`);
    } else if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', service: 'SAND POINT GLOBAL WhatsApp Bot', qr_available: !!currentQrData }));
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
console.log('🚀 بدء تشغيل بوت ساند بوينت العالمية (7 لغات + مضادات حظر إنسانيات)...');
startServer();
connectToWhatsApp().catch(console.error);
