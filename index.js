require("dotenv").config();
require("dotenv").config({ path: `${__dirname}/.env.local`, override: true });
require("dotenv").config({ path: `${__dirname}/.mail.local`, override: true });

const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadToCloudinary = async (filePath, folder = "kolystore") => {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    const fileName = path.basename(filePath);
    return `/uploads/${fileName}`;
  }

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: folder,
    });
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error("Error deleting local file:", err);
      });
    }
    return result.secure_url;
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);
    const fileName = path.basename(filePath);
    return `/uploads/${fileName}`;
  }
};

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

const app = express();

const port = process.env.PORT || 5000;

const mailUser = (process.env.NODEMAILER_USER || "").trim();
const mailService = (process.env.MAIL_SERVICE || "gmail").trim().toLowerCase();

const mailPass = mailService === "gmail"
  ? (process.env.NODEMAILER_PASS || "").replace(/\s/g, "")
  : (process.env.NODEMAILER_PASS || "").trim();

const smtpHost = (process.env.SMTP_HOST || "").trim();
const smtpPort = Number(process.env.SMTP_PORT || (mailService === "cpanel" ? 465 : 465));
const smtpSecure = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === "true"
  : smtpPort === 465;

const transportOptions = smtpHost
  ? {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: mailUser,
        pass: mailPass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    }
  : {
      service: "gmail",
      auth: {
        user: mailUser,
        pass: mailPass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    };

const mailTransporter =
  mailUser && mailPass
    ? nodemailer.createTransport(transportOptions)
    : null;

if (!mailTransporter) {
  console.warn("Email is disabled: NODEMAILER_USER and NODEMAILER_PASS are required.");
} else {
  // This runs at app startup, so cPanel's Node.js application log shows a
  // concrete SMTP error instead of silently failing after an order is placed.
  mailTransporter.verify().then(
    () => console.log(`Email SMTP connection verified (${smtpHost || "Gmail"}).`),
    (error) => console.error("Email SMTP connection failed:", error.message)
  );
}

const resolveAdminEmail = async () => {
  if (usersCollection) {
    const admin = await usersCollection.findOne(
      { role: { $regex: /^admin$/i } },
      { projection: { email: 1 } }
    );
    const fromDb =
      typeof admin?.email === "string" ? admin.email.trim() : "";
    if (fromDb) return fromDb;
  }

  const fromEnv = (process.env.ADMIN_EMAIL || "").trim();
  return fromEnv || null;
};

const sendEmail = async ({ to, subject, text, html }) => {
  const recipient = typeof to === "string" ? to.trim() : "";
  if (!mailTransporter || !recipient) {
    if (!mailTransporter && recipient) {
      console.warn(
        "Email skipped (set NODEMAILER_USER and NODEMAILER_PASS in .mail.local or .env):",
        subject
      );
    }
    return;
  }

  try {
    await mailTransporter.sendMail({
      from: process.env.MAIL_FROM || `KolyStore <${mailUser}>`,
      to: recipient,
      subject,
      text,
      html,
    });
  } catch (error) {
    // Email delivery must not undo a completed signup or order.
    console.error("Email delivery error:", error.message);
  }
};

// Assigned after the database connection is established. Keeping this available
// to the auth middleware lets a newly blocked user lose access immediately,
// including from an already-issued cookie.
let usersCollection;

// =====================================================
// MIDDLEWARE
// =====================================================

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "https://kolystore.com",
  "https://kolystore.com",
  "https://www.kolystore.com",
  "https://www.kolystore.com",
  "https://api.kolystore.com",
  "https://api.kolystore.com",
];

if (process.env.CLIENT_URL) allowedOrigins.push(process.env.CLIENT_URL);
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      origin.includes("kolystore.com") ||
      origin.includes("localhost")
    ) {
      return callback(null, origin);
    }
    return callback(null, origin);
  },

  credentials: true,

  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

app.use(express.json());

app.use(cookieParser());

// The API key stays on the server. Never put a DeepL key in Vite/React env vars,
// because all VITE_* values are exposed to every browser visitor.
app.post("/translate", async (req, res) => {
  const { texts, targetLanguage } = req.body || {};
  const supportedLanguages = new Set(["DE", "EN"]);

  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 50 || !supportedLanguages.has(targetLanguage)) {
    return res.status(400).send({ success: false, message: "Invalid translation request" });
  }

  if (!texts.every((text) => typeof text === "string" && text.length <= 5000)) {
    return res.status(400).send({ success: false, message: "Translation text is invalid" });
  }

  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    return res.status(503).send({ success: false, message: "DeepL is not configured. Add DEEPL_API_KEY to server/.env." });
  }

  const apiUrl = process.env.DEEPL_API_URL || (apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate");

  try {
    const deepLResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: texts, source_lang: "EN", target_lang: targetLanguage }),
    });
    const data = await deepLResponse.json();

    if (!deepLResponse.ok) {
      console.error("DeepL API error:", data);
      return res.status(deepLResponse.status).send({ success: false, message: "DeepL could not translate the page" });
    }

    return res.send({ success: true, translations: data.translations.map((translation) => translation.text) });
  } catch (error) {
    console.error("DeepL request error:", error);
    return res.status(502).send({ success: false, message: "Unable to reach DeepL" });
  }
});

const toBoolean = (value) =>
  value === true ||
  value === "true" ||
  value === "1" ||
  value === 1;

const parseStringList = (value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  let list = value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      list = parsed;
    } catch {
      list = value.split(",").map((item) => item.trim());
    }
  }

  if (!Array.isArray(list)) {
    list = [list];
  }

  return [
    ...new Set(
      list
        .filter(
          (item) =>
            typeof item === "string" && item.trim() !== ""
        )
        .map((item) => item.trim())
    ),
  ];
};

// =====================================================
// UPLOAD FOLDER
// =====================================================

const uploadFolder = path.join(
  __dirname,
  "uploads"
);

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, {
    recursive: true,
  });
}

app.use(
  "/uploads",
  express.static(uploadFolder)
);

// =====================================================
// MULTER
// =====================================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadFolder);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    files: 3,
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only image files are allowed"
        )
      );
    }
  },
});

// =====================================================
// JWT VERIFY
// =====================================================

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

  const token = bearerToken || req.cookies?.token;

  if (!token) {
    return res.status(401).send({
      success: false,
      message: "Unauthorized access",
    });
  }

  jwt.verify(
    token,
    process.env.ACCESS_TOKEN_SECRET,
    async (err, decoded) => {
      if (err) {
        return res.status(401).send({
          success: false,
          message: "Invalid or expired token",
        });
      }

      try {
        if (!usersCollection || !ObjectId.isValid(decoded.userId)) {
          throw new Error("User collection is unavailable");
        }

        const user = await usersCollection.findOne(
          { _id: new ObjectId(decoded.userId) },
          { projection: { status: 1, role: 1 } }
        );

        if (!user || user.status === "blocked") {
          res.clearCookie("token", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite:
              process.env.NODE_ENV === "production" ? "none" : "strict",
          });

          return res.status(403).send({
            success: false,
            message: "Your account has been blocked. Please contact support.",
          });
        }

        req.user = {
          ...decoded,
          role: user.role || decoded.role,
        };
      } catch (error) {
        console.error("User status verification error:", error);
        return res.status(500).send({
          success: false,
          message: "Unable to verify account status",
        });
      }

      next();
    }
  );
};

// =====================================================
// ADMIN VERIFY MIDDLEWARE
// =====================================================

const verifyAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized access",
      });
    }

    const userId = req.user.userId;
    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(401).send({
        success: false,
        message: "Invalid user authentication",
      });
    }

    if (!usersCollection) {
      return res.status(500).send({
        success: false,
        message: "Database error",
      });
    }

    const user = await usersCollection.findOne(
      { _id: new ObjectId(userId) },
      { projection: { role: 1, status: 1 } }
    );

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    if (user.status === "blocked") {
      res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      });
      return res.status(403).send({
        success: false,
        message: "Your account has been blocked.",
      });
    }

    if (!user.role || user.role.toLowerCase() !== "admin") {
      return res.status(403).send({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    next();
  } catch (error) {
    console.error("Verify Admin Error:", error);
    return res.status(500).send({
      success: false,
      message: "Failed to verify admin authorization",
    });
  }
};

// =====================================================
// MONGODB
// =====================================================

const uri =
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}` +
  `@cluster0-shard-00-00.nnldx.mongodb.net:27017,` +
  `cluster0-shard-00-01.nnldx.mongodb.net:27017,` +
  `cluster0-shard-00-02.nnldx.mongodb.net:27017/` +
  `?ssl=true&replicaSet=atlas-6day14-shard-0` +
  `&authSource=admin&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// =====================================================
// PASSWORD HASH
// =====================================================

const hashPassword = (
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) => {
  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
};

// =====================================================
// VERIFY PASSWORD
// =====================================================

const verifyPassword = (
  password,
  storedPassword
) => {
  const [
    salt,
    storedHash,
  ] = (storedPassword || "").split(":");

  if (!salt || !storedHash) {
    return false;
  }

  const derivedHash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  const storedBuffer = Buffer.from(
    storedHash,
    "hex"
  );

  const derivedBuffer = Buffer.from(
    derivedHash,
    "hex"
  );

  if (
    storedBuffer.length !==
    derivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    storedBuffer,
    derivedBuffer
  );
};

// =====================================================
// SERVER
// =====================================================

async function run() {
  try {

    // =================================================
    // CONNECT MONGODB
    // =================================================

    await client.connect();

    console.log(
      "MongoDB connected successfully!"
    );

    // =================================================
    // DATABASE
    // =================================================

    const db =
      client.db("Koly_Store");

    // =================================================
    // COLLECTIONS
    // =================================================

    usersCollection =
      db.collection("users");

    const countersCollection =
      db.collection("counters");

    const productsCollection =
      db.collection("products");

    const wishlistCollection =
      db.collection("wishlists");

    const cartCollection =
      db.collection("carts");

    const ordersCollection =
      db.collection("orders");

    const contactMessagesCollection =
      db.collection("contactMessages");

    const productQuestionsCollection =
      db.collection("productQuestions");

    const storeSettingsCollection =
      db.collection("storeSettings");

    // =====================================================
    // SITEMAP.XML ROUTE (FOR GOOGLE FAST INDEXING & SEO)
    // =====================================================

    app.get("/sitemap.xml", async (req, res) => {
      try {
        const baseUrl = "https://kolystore.com";
        const staticPages = [
          { url: "/", priority: "1.0", changefreq: "daily" },
          { url: "/all-products", priority: "0.9", changefreq: "daily" },
          { url: "/about", priority: "0.7", changefreq: "monthly" },
          { url: "/contact-us", priority: "0.7", changefreq: "monthly" },
        ];

        let categories = ["seeds", "plants", "vegetables", "toys", "clothes", "cosmetic"];
        try {
          const fetchedCategories = await productsCollection.distinct("category");
          if (Array.isArray(fetchedCategories) && fetchedCategories.length > 0) {
            const formatted = fetchedCategories
              .filter(Boolean)
              .map((c) =>
                String(c)
                  .toLowerCase()
                  .trim()
                  .replace(/&/g, "and")
                  .replace(/[^a-z0-9\s-]/g, "")
                  .replace(/\s+/g, "-")
              );
            categories = [...new Set([...categories, ...formatted])];
          }
        } catch (e) {
          console.error("Sitemap category error:", e);
        }

        let products = [];
        try {
          products = await productsCollection
            .find(
              { $or: [{ isActive: true }, { isActive: { $exists: false } }] },
              { projection: { _id: 1, updatedAt: 1, createdAt: 1 } }
            )
            .toArray();
        } catch (e) {
          console.error("Sitemap product error:", e);
        }

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

        staticPages.forEach((page) => {
          xml += `  <url>\n`;
          xml += `    <loc>${baseUrl}${page.url}</loc>\n`;
          xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
          xml += `    <priority>${page.priority}</priority>\n`;
          xml += `  </url>\n`;
        });

        categories.forEach((cat) => {
          if (cat) {
            xml += `  <url>\n`;
            xml += `    <loc>${baseUrl}/category/${encodeURIComponent(cat)}</loc>\n`;
            xml += `    <changefreq>daily</changefreq>\n`;
            xml += `    <priority>0.8</priority>\n`;
            xml += `  </url>\n`;
          }
        });

        products.forEach((prod) => {
          const lastmod = prod.updatedAt || prod.createdAt;
          const formattedDate = lastmod ? new Date(lastmod).toISOString().split("T")[0] : null;
          xml += `  <url>\n`;
          xml += `    <loc>${baseUrl}/product/${prod._id}</loc>\n`;
          if (formattedDate) {
            xml += `    <lastmod>${formattedDate}</lastmod>\n`;
          }
          xml += `    <changefreq>weekly</changefreq>\n`;
          xml += `    <priority>0.7</priority>\n`;
          xml += `  </url>\n`;
        });

        xml += `</urlset>`;

        res.header("Content-Type", "application/xml");
        return res.send(xml);
      } catch (error) {
        console.error("Sitemap route error:", error);
        return res.status(500).send("Error generating sitemap");
      }
    });

    // =====================================================
    // CONTACT US ROUTE
    // =====================================================

    app.post("/contact-us", async (req, res) => {
      try {
        const { name, email, phone, subject, message } = req.body || {};

        if (!name || !email || !message) {
          return res.status(400).send({
            success: false,
            message: "Name, email, and message are required.",
          });
        }

        const adminEmail = await resolveAdminEmail();
        const targetEmail = adminEmail || "info@kolystore.com";

        const newMessage = {
          name: String(name).trim(),
          email: String(email).trim(),
          phone: String(phone || "").trim(),
          subject: String(subject || "").trim(),
          message: String(message).trim(),
          createdAt: new Date(),
          status: "unread",
        };

        await contactMessagesCollection.insertOne(newMessage);

        const emailText = `
You have received a new contact message on KolyStore:

Name: ${newMessage.name}
Email: ${newMessage.email}
Phone: ${newMessage.phone || "N/A"}
Subject: ${newMessage.subject || "N/A"}

Message:
${newMessage.message}

Received at: ${new Date().toLocaleString()}
`;

        await sendEmail({
          to: targetEmail,
          subject: `[KolyStore Contact] ${newMessage.subject || "New Message from " + newMessage.name}`,
          text: emailText,
        });

        return res.status(200).send({
          success: true,
          message: "Thank you! Your message has been sent successfully.",
        });
      } catch (error) {
        console.error("CONTACT US ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Could not send message. Please try again later.",
        });
      }
    });

    // =====================================================
    // PRODUCT QUESTIONS ROUTE
    // =====================================================

    app.post("/product-questions", async (req, res) => {
      try {
        const { name, email, phone, productName, productId, question } = req.body || {};

        if (!question || !productName) {
          return res.status(400).send({
            success: false,
            message: "Question and product name are required.",
          });
        }

        const adminEmail = await resolveAdminEmail();
        const targetEmail = adminEmail || "info@kolystore.com";

        const newQuestion = {
          name: String(name || "Anonymous").trim(),
          email: String(email || "").trim(),
          phone: String(phone || "").trim(),
          productName: String(productName).trim(),
          productId: String(productId || "").trim(),
          question: String(question).trim(),
          createdAt: new Date(),
          status: "pending",
        };

        await productQuestionsCollection.insertOne(newQuestion);

        const emailText = `
You have received a new product question on KolyStore:

Product Name: ${newQuestion.productName}
Product ID: ${newQuestion.productId || "N/A"}

Customer Name: ${newQuestion.name}
Customer Email: ${newQuestion.email || "N/A"}
Customer Phone: ${newQuestion.phone || "N/A"}

Question:
${newQuestion.question}

Received at: ${new Date().toLocaleString()}
`;

        await sendEmail({
          to: targetEmail,
          subject: `[KolyStore Question] Product Question: ${newQuestion.productName}`,
          text: emailText,
        });

        return res.status(200).send({
          success: true,
          message: "Thank you! Your question has been submitted successfully.",
        });
      } catch (error) {
        console.error("PRODUCT QUESTION ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Could not submit question. Please try again later.",
        });
      }
    });

    // =================================================
    // USER INDEXES
    // =================================================

    await usersCollection.createIndex(
      { email: 1 },
      { unique: true }
    );

    await usersCollection.createIndex(
      { phone: 1 },
      { unique: true }
    );

    await usersCollection.createIndex(
      { customerId: 1 },
      { unique: true }
    );

    // =================================================
    // PRODUCT INDEX
    // =================================================

    await productsCollection.createIndex(
      { productId: 1 },
      { unique: true }
    );

    // The storefront always shows newest products first. This index keeps that
    // public query fast as the catalogue grows.
    await productsCollection.createIndex({ createdAt: -1 });

    await wishlistCollection.createIndex(
      { userId: 1, productId: 1 },
      { unique: true }
    );

    await cartCollection.createIndex(
      { userId: 1, productId: 1 },
      { unique: true }
    );

    await ordersCollection.createIndex({ orderId: 1 }, { unique: true });
    await ordersCollection.createIndex({ userId: 1, createdAt: -1 });

    // =====================================================
    // SIGNUP API
    // =====================================================

    app.post(
      "/signup",
      async (req, res) => {
        try {

          const {
            name,
            email,
            phone,
            password,
            confirmPassword,
          } = req.body;

          // ---------------------------------------------
          // NAME
          // ---------------------------------------------

          if (
            !name ||
            !name.trim()
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Name is required",
            });
          }

          // ---------------------------------------------
          // EMAIL
          // ---------------------------------------------

          if (
            !email ||
            !email.trim()
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Email is required",
            });
          }

          // ---------------------------------------------
          // PHONE
          // ---------------------------------------------

          if (
            !phone ||
            !phone.trim()
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Phone number is required",
            });
          }

          const cleanPhone =
            phone.trim();

          if (
            !/^[0-9+\-\s()]{7,20}$/.test(
              cleanPhone
            )
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Invalid phone number",
            });
          }

          // ---------------------------------------------
          // PASSWORD
          // ---------------------------------------------

          if (!password) {
            return res.status(400).send({
              success: false,
              message:
                "Password is required",
            });
          }

          if (!confirmPassword) {
            return res.status(400).send({
              success: false,
              message:
                "Confirm password is required",
            });
          }

          if (
            password !==
            confirmPassword
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Passwords do not match",
            });
          }

          if (password.length < 6) {
            return res.status(400).send({
              success: false,
              message:
                "Password must be at least 6 characters",
            });
          }

          // ---------------------------------------------
          // CLEAN DATA
          // ---------------------------------------------

          const cleanName =
            name.trim();

          const cleanEmail =
            email
              .trim()
              .toLowerCase();

          // ---------------------------------------------
          // CHECK EMAIL
          // ---------------------------------------------

          const existingUser =
            await usersCollection.findOne({
              email: cleanEmail,
            });

          if (existingUser) {
            return res.status(409).send({
              success: false,
              message:
                existingUser.status === "blocked"
                  ? "This email belongs to a blocked account and cannot be used to sign up."
                  : "Email already exists",
            });
          }

          // ---------------------------------------------
          // CHECK PHONE
          // ---------------------------------------------

          const existingPhone =
            await usersCollection.findOne({
              phone: cleanPhone,
            });

          if (existingPhone) {
            return res.status(409).send({
              success: false,
              message:
                "Phone number already exists",
            });
          }

          // ---------------------------------------------
          // HASH PASSWORD
          // ---------------------------------------------

          const hashedPassword =
            hashPassword(password);

          // ---------------------------------------------
          // CUSTOMER ID
          // ---------------------------------------------

          const counter =
            await countersCollection.findOneAndUpdate(
              {
                _id: "customerId",
              },
              {
                $inc: {
                  sequence: 1,
                },
              },
              {
                upsert: true,
                returnDocument: "after",
              }
            );

          if (
            !counter ||
            typeof counter.sequence !==
              "number"
          ) {
            throw new Error(
              "Customer ID counter could not be generated"
            );
          }

          const customerNumber =
            counter.sequence;

          const customerId =
            `CUS-${String(
              customerNumber
            ).padStart(6, "0")}`;

          // ---------------------------------------------
          // USER
          // ---------------------------------------------

          const user = {
            customerId,
            customerNumber,

            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,

            password: hashedPassword,

            role: "customer",

            createdAt: new Date(),
            updatedAt: new Date(),
          };

          // ---------------------------------------------
          // INSERT USER
          // ---------------------------------------------

          const result =
            await usersCollection.insertOne(
              user
            );

          // ---------------------------------------------
          // TOKEN
          // ---------------------------------------------

          const tokenPayload = {
            userId:
              result.insertedId.toString(),

            customerId:
              user.customerId,

            email:
              user.email,

            role:
              user.role,
          };

          const token =
            jwt.sign(
              tokenPayload,
              process.env
                .ACCESS_TOKEN_SECRET,
              {
                expiresIn: "365d",
              }
            );

          // ---------------------------------------------
          // COOKIE
          // ---------------------------------------------

          res.cookie(
            "token",
            token,
            {
              httpOnly: true,

              secure:
                process.env.NODE_ENV ===
                "production",

              sameSite:
                process.env.NODE_ENV ===
                "production"
                  ? "none"
                  : "strict",

              maxAge:
                365 *
                24 *
                60 *
                60 *
                1000,
            }
          );

          // ---------------------------------------------
          // RESPONSE
          // ---------------------------------------------

    void sendEmail({
  to: user.email,
  subject: "Welcome to KOLY STORE 🎉",
  html: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #f5f7f4;
            font-family: Arial, Helvetica, sans-serif;
          }

          .wrapper {
            width: 100%;
            padding: 30px 15px;
            background: #f5f7f4;
          }

          .container {
            width: 100%;
            max-width: 600px;
            margin: auto;
            background: #ffffff;
            border-radius: 16px;
            overflow: hidden;
          }

          .header {
            background: #498520;
            padding: 30px 20px;
            text-align: center;
          }

          .logo {
            margin: 0;
            color: #ffffff;
            font-size: 28px;
            font-weight: 700;
          }

          .content {
            padding: 35px 30px;
          }

          .title {
            color: #222222;
            font-size: 24px;
            margin: 0 0 15px;
          }

          .text {
            color: #555555;
            font-size: 15px;
            line-height: 1.7;
          }

          .card {
            margin: 25px 0;
            padding: 20px;
            background: #f7faf5;
            border: 1px solid #dcebd4;
            border-radius: 12px;
          }

          .card-title {
            margin: 0 0 15px;
            color: #498520;
            font-size: 17px;
          }

          .info {
            margin: 10px 0;
            color: #555555;
            font-size: 14px;
          }

          .button-wrapper {
            text-align: center;
            margin: 30px 0;
          }

          .button {
            display: inline-block;
            padding: 14px 28px;
            background: #498520;
            color: #ffffff !important;
            text-decoration: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
          }

          .footer {
            padding: 22px 20px;
            text-align: center;
            background: #f8f8f8;
            border-top: 1px solid #eeeeee;
          }

          .footer-logo {
            color: #498520;
            font-size: 17px;
            font-weight: 700;
            margin: 0 0 8px;
          }

          .footer-text {
            color: #888888;
            font-size: 12px;
            margin: 0;
          }

          @media only screen and (max-width: 480px) {
            .wrapper {
              padding: 10px 5px;
            }

            .container {
              border-radius: 10px;
            }

            .header {
              padding: 24px 15px;
            }

            .logo {
              font-size: 23px;
            }

            .content {
              padding: 25px 18px;
            }

            .title {
              font-size: 21px;
            }

            .text {
              font-size: 14px;
            }

            .card {
              padding: 17px 14px;
            }

            .button {
              display: block;
              width: 100%;
              padding: 14px 0;
            }
          }
        </style>
      </head>

      <body>
        <div class="wrapper">
          <div class="container">

            <div class="header">
              <h1 class="logo">KOLY STORE</h1>
            </div>

            <div class="content">

              <h2 class="title">
                Welcome, ${user.name}! 
              </h2>

              <p class="text">
                Thank you for joining <strong>KOLY STORE</strong>.
                Your account has been created successfully.
              </p>

              <div class="card">

                <h3 class="card-title">
                  Account Information
                </h3>

                <p class="info">
                  <strong>Name:</strong> ${user.name}
                </p>

                <p class="info">
                  <strong>Email:</strong> ${user.email}
                </p>

                <p class="info">
                  <strong>Customer ID:</strong> ${user.customerId}
                </p>

              </div>

              <p class="text">
                You can now access your account and explore our products.
                We hope you enjoy shopping with us!
              </p>

              <div class="button-wrapper">
                <a
                  href="https://kolystore.com"
                  class="button"
                  target="_blank"
                >
                  Visit KOLY STORE
                </a>
              </div>

              <p class="text">
                If you have any questions or need assistance,
                please feel free to contact our support team.
              </p>

            </div>

            <div class="footer">
              <p class="footer-logo">
                KOLY STORE
              </p>

              <p class="footer-text">
                Thank you for choosing KOLY STORE.
              </p>

              <p class="footer-text">
                © ${new Date().getFullYear()} KOLY STORE.
                All rights reserved.
              </p>
            </div>

          </div>
        </div>
      </body>
    </html>
  `.trim(),
});
const adminEmail = await resolveAdminEmail();

if (adminEmail) {
  void sendEmail({
    to: adminEmail,
    subject: "New KolyStore Customer Signup",

    text:
      "A new customer has signed up on KolyStore.\n\n" +
      `Name: ${user.name || "N/A"}\n` +
      `Email: ${user.email || "N/A"}\n` +
      `Phone: ${user.phone || "N/A"}\n` +
      `Customer ID: ${user.customerId || "N/A"}`,

    html: `
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>New Customer Signup</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background-color:#f4f7f2;
    font-family:Arial, Helvetica, sans-serif;
    color:#1f2937;
  "
>

  <!-- Outer Wrapper -->
  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="
      width:100%;
      background-color:#f4f7f2;
      padding:30px 15px;
    "
  >
    <tr>
      <td align="center">

        <!-- Main Card -->
        <table
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            width:100%;
            max-width:600px;
            background-color:#ffffff;
            border-radius:14px;
            overflow:hidden;
          "
        >

          <!-- ================= HEADER ================= -->
          <tr>
            <td
              style="
                background-color:#498520;
                padding:28px 25px;
                text-align:center;
              "
            >

              <div
                style="
                  font-size:26px;
                  line-height:1.3;
                  font-weight:700;
                  color:#ffffff;
                  letter-spacing:0.5px;
                "
              >
                KolyStore
              </div>

              <div
                style="
                  margin-top:7px;
                  font-size:13px;
                  line-height:1.5;
                  color:#eaf5e4;
                "
              >
                Customer Management System
              </div>

            </td>
          </tr>


          <!-- ================= CONTENT ================= -->
          <tr>
            <td
              style="
                padding:32px 28px;
              "
            >

              <!-- Heading -->
              <h1
                style="
                  margin:0;
                  padding:0;
                  font-size:24px;
                  line-height:1.3;
                  font-weight:700;
                  color:#111827;
                "
              >
                New Customer Signup
              </h1>


              <!-- Description -->
              <p
                style="
                  margin:12px 0 25px;
                  padding:0;
                  font-size:14px;
                  line-height:1.7;
                  color:#6b7280;
                "
              >
                A new customer has successfully created an account
                on your KolyStore website.
              </p>


              <!-- ================= CUSTOMER TABLE ================= -->
              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                  width:100%;
                  table-layout:fixed;
                  border:1px solid #e5e7eb;
                  border-radius:10px;
                  overflow:hidden;
                "
              >

                <!-- Table Header -->
                <tr>
                  <td
                    colspan="2"
                    style="
                      background-color:#f8faf7;
                      padding:15px 16px;
                      font-size:14px;
                      line-height:1.5;
                      font-weight:700;
                      color:#374151;
                      border-bottom:1px solid #e5e7eb;
                    "
                  >
                    Customer Information
                  </td>
                </tr>


                <!-- ================= NAME ================= -->
                <tr>

                  <td
                    width="30%"
                    style="
                      width:30%;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      color:#6b7280;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                    "
                  >
                    Name
                  </td>

                  <td
                    width="70%"
                    style="
                      width:70%;
                      max-width:0;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      font-weight:600;
                      color:#111827;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                      overflow:hidden;
                      text-overflow:ellipsis;
                    "
                  >
                    ${user.name || "N/A"}
                  </td>

                </tr>


                <!-- ================= EMAIL ================= -->
                <tr>

                  <td
                    width="30%"
                    style="
                      width:30%;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      color:#6b7280;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                    "
                  >
                    Email
                  </td>

                  <td
                    width="70%"
                    style="
                      width:70%;
                      max-width:0;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      font-weight:600;
                      color:#111827;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                      overflow:hidden;
                      text-overflow:ellipsis;
                    "
                  >
                    ${user.email || "N/A"}
                  </td>

                </tr>


                <!-- ================= PHONE ================= -->
                <tr>

                  <td
                    width="30%"
                    style="
                      width:30%;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      color:#6b7280;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                    "
                  >
                    Phone
                  </td>

                  <td
                    width="70%"
                    style="
                      width:70%;
                      max-width:0;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      font-weight:600;
                      color:#111827;
                      border-bottom:1px solid #f0f0f0;
                      vertical-align:middle;
                      white-space:nowrap;
                      overflow:hidden;
                      text-overflow:ellipsis;
                    "
                  >
                    ${user.phone || "N/A"}
                  </td>

                </tr>


                <!-- ================= CUSTOMER ID ================= -->
                <tr>

                  <td
                    width="30%"
                    style="
                      width:30%;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      color:#6b7280;
                      vertical-align:middle;
                      white-space:nowrap;
                    "
                  >
                    Customer ID
                  </td>

                  <td
                    width="70%"
                    style="
                      width:70%;
                      max-width:0;
                      padding:14px 16px;
                      font-size:13px;
                      line-height:1.5;
                      font-weight:700;
                      color:#498520;
                      vertical-align:middle;
                      white-space:nowrap;
                      overflow:hidden;
                      text-overflow:ellipsis;
                    "
                  >
                    ${user.customerId || "N/A"}
                  </td>

                </tr>

              </table>


              <!-- ================= NOTICE ================= -->
              <div
                style="
                  margin-top:24px;
                  padding:14px 16px;
                  background-color:#f8faf7;
                  border-left:4px solid #498520;
                  border-radius:6px;
                "
              >

                <p
                  style="
                    margin:0;
                    padding:0;
                    font-size:12px;
                    line-height:1.6;
                    color:#6b7280;
                  "
                >
                  This is an automated notification from KolyStore.
                  No action is required unless you need to review the
                  customer's account.
                </p>

              </div>

            </td>
          </tr>


          <!-- ================= FOOTER ================= -->
          <tr>
            <td
              style="
                padding:20px 25px;
                background-color:#f8faf7;
                text-align:center;
                border-top:1px solid #edf0eb;
              "
            >

              <p
                style="
                  margin:0;
                  padding:0;
                  font-size:12px;
                  line-height:1.6;
                  color:#6b7280;
                "
              >
                © ${new Date().getFullYear()} KolyStore.
                All rights reserved.
              </p>

              <p
                style="
                  margin:5px 0 0;
                  padding:0;
                  font-size:11px;
                  line-height:1.5;
                  color:#9ca3af;
                "
              >
                Automated Customer Notification
              </p>

            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
    `,
  });
} else {
  console.warn(
    "Admin signup notification skipped: no admin email in users collection"
  );
}
          return res.status(201).send({
            success: true,

            message:
              "Account created successfully",

            // The frontend uses this token for Authorization headers. Returning
            // it also makes authentication reliable when browsers reject a
            // cross-subdomain cookie.
            token,

            user: {
              userId:
                result.insertedId,

              customerId:
                user.customerId,

              customerNumber:
                user.customerNumber,

              name:
                user.name,

              email:
                user.email,

              phone:
                user.phone,

              role:
                user.role,

              createdAt:
                user.createdAt,
            },
          });

        } catch (error) {

          console.error(
            "Signup Error:",
            error
          );

          if (
            error.code === 11000
          ) {
            return res.status(409).send({
              success: false,
              message:
                "Email, phone or customer ID already exists",
            });
          }

          return res.status(500).send({
            success: false,
            message:
              "Failed to create account",
          });
        }
      }
    );

    // =====================================================
    // LOGIN API
    // =====================================================

    app.post(
      "/login",
      async (req, res) => {
        try {

          const {
            email,
            password,
          } = req.body;

          if (
            !email ||
            !password
          ) {
            return res.status(400).send({
              success: false,
              message:
                "Email and password are required",
            });
          }

          const cleanEmail =
            email
              .trim()
              .toLowerCase();

          const user =
            await usersCollection.findOne({
              email: cleanEmail,
            });

          if (!user) {
            return res.status(404).send({
              success: false,
              message:
                "Email address not found. This email is not registered.",
            });
          }

          if (user.status === "blocked") {
            return res.status(403).send({
              success: false,
              message:
                "Your account has been blocked. Please contact support.",
            });
          }

          const passwordValid =
            verifyPassword(
              password,
              user.password
            );

          if (!passwordValid) {
            return res.status(401).send({
              success: false,
              message:
                "Incorrect password. Please check your password and try again.",
            });
          }

          const tokenPayload = {
            userId:
              user._id.toString(),

            customerId:
              user.customerId,

            email:
              user.email,

            role:
              user.role,
          };

          const token =
            jwt.sign(
              tokenPayload,
              process.env
                .ACCESS_TOKEN_SECRET,
              {
                expiresIn: "365d",
              }
            );

          res.cookie(
            "token",
            token,
            {
              httpOnly: true,

              secure:
                process.env.NODE_ENV ===
                "production",

              sameSite:
                process.env.NODE_ENV ===
                "production"
                  ? "none"
                  : "strict",

              maxAge:
                365 *
                24 *
                60 *
                60 *
                1000,
            }
          );

          return res.send({
            success: true,

            message:
              "Login successful",

            // Keep bearer-token authentication available in addition to the
            // HttpOnly cookie set above.
            token,

            user: {
              userId:
                user._id,

              customerId:
                user.customerId,

              name:
                user.name,

              email:
                user.email,

              phone:
                user.phone,

              role:
                user.role,
            },
          });

        } catch (error) {

          console.error(
            "Login Error:",
            error
          );

          return res.status(500).send({
            success: false,
            message:
              "Server error",
          });
        }
      }
    );

    // =====================================================
    // FORGOT PASSWORD - SEND OTP
    // =====================================================

    app.post("/forgot-password/send-otp", async (req, res) => {
      try {
        const { email } = req.body;

        if (!email || typeof email !== "string" || !email.trim()) {
          return res.status(400).send({
            success: false,
            message: "Email address is required",
          });
        }

        const cleanEmail = email.trim().toLowerCase();

        const user = await usersCollection.findOne({ email: cleanEmail });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "Email address not found. This email is not registered.",
          });
        }

        if (user.status === "blocked") {
          return res.status(403).send({
            success: false,
            message: "Your account is blocked. Please contact support.",
          });
        }

        // Generate 6-digit numeric OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await usersCollection.updateOne(
          { email: cleanEmail },
          {
            $set: {
              resetOtp: otp,
              resetOtpExpires: expiresAt,
              updatedAt: new Date(),
            },
          }
        );

        // Send OTP email
        void sendEmail({
          to: cleanEmail,
          subject: "Password Reset OTP – KolyStore",
          text:
            `Hello ${user.name || "Customer"},\n\n` +
            `Your OTP for resetting your KolyStore account password is:\n\n` +
            `   ${otp}\n\n` +
            `This OTP is valid for 10 minutes.\n\n` +
            `If you did not request a password reset, please ignore this email.`,
        });

        return res.status(200).send({
          success: true,
          message: "OTP has been sent to your email address.",
        });
      } catch (error) {
        console.error("SEND OTP ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Failed to send OTP. Please try again later.",
        });
      }
    });

    // =====================================================
    // FORGOT PASSWORD - VERIFY OTP
    // =====================================================

    app.post("/forgot-password/verify-otp", async (req, res) => {
      try {
        const { email, otp } = req.body;

        if (!email || !otp) {
          return res.status(400).send({
            success: false,
            message: "Email and OTP are required",
          });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanOtp = String(otp).trim();

        const user = await usersCollection.findOne({ email: cleanEmail });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        if (!user.resetOtp || user.resetOtp !== cleanOtp) {
          return res.status(400).send({
            success: false,
            message: "Invalid OTP. Please check the OTP sent to your email.",
          });
        }

        if (
          !user.resetOtpExpires ||
          new Date() > new Date(user.resetOtpExpires)
        ) {
          return res.status(400).send({
            success: false,
            message: "OTP has expired. Please request a new OTP.",
          });
        }

        return res.status(200).send({
          success: true,
          message: "OTP verified successfully.",
        });
      } catch (error) {
        console.error("VERIFY OTP ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Failed to verify OTP",
        });
      }
    });

    // =====================================================
    // FORGOT PASSWORD - RESET PASSWORD
    // =====================================================

    app.post("/forgot-password/reset-password", async (req, res) => {
      try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
          return res.status(400).send({
            success: false,
            message: "Email, OTP, and new password are required",
          });
        }

        if (String(newPassword).length < 6) {
          return res.status(400).send({
            success: false,
            message: "New password must be at least 6 characters long",
          });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanOtp = String(otp).trim();

        const user = await usersCollection.findOne({ email: cleanEmail });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        if (!user.resetOtp || user.resetOtp !== cleanOtp) {
          return res.status(400).send({
            success: false,
            message: "Invalid OTP. Please request a new password reset.",
          });
        }

        if (
          !user.resetOtpExpires ||
          new Date() > new Date(user.resetOtpExpires)
        ) {
          return res.status(400).send({
            success: false,
            message: "OTP has expired. Please request a new OTP.",
          });
        }

        const hashedPassword = hashPassword(String(newPassword));

        await usersCollection.updateOne(
          { email: cleanEmail },
          {
            $set: {
              password: hashedPassword,
              updatedAt: new Date(),
            },
            $unset: {
              resetOtp: "",
              resetOtpExpires: "",
            },
          }
        );

        // Send confirmation email
        void sendEmail({
          to: cleanEmail,
          subject: "Password Reset Successful – KolyStore",
          text:
            `Hello ${user.name || "Customer"},\n\n` +
            `Your KolyStore account password has been successfully reset.\n\n` +
            `You can now log in with your new password.`,
        });

        return res.status(200).send({
          success: true,
          message: "Password reset successful. You can now log in.",
        });
      } catch (error) {
        console.error("RESET PASSWORD ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Failed to reset password",
        });
      }
    });

    // =====================================================
    // LOGOUT API
    // =====================================================

    app.get(
      "/logout",
      (req, res) => {

        res.clearCookie(
          "token",
          {
            httpOnly: true,

            secure:
              process.env.NODE_ENV ===
              "production",

            sameSite:
              process.env.NODE_ENV ===
              "production"
                ? "none"
                : "strict",
          }
        );

        res.send({
          success: true,
          message:
            "Logout successful",
        });
      }
    );

    // =====================================================
    // GET CURRENT USER
    // =====================================================

    app.get(
      "/profile",
      verifyToken,
      async (req, res) => {
        try {

          const user =
            await usersCollection.findOne(
              {
                _id: new ObjectId(
                  req.user.userId
                ),
              },
              {
                projection: {
                  password: 0,
                },
              }
            );

          if (!user) {
            return res
              .status(404)
              .send({
                success: false,
                message:
                  "User not found",
              });
          }

          res.status(200).send({
            success: true,
            user,
          });

        } catch (error) {

          console.error(
            "Profile Error:",
            error
          );

          res.status(500).send({
            success: false,
            message:
              "Server error",
          });
        }
      }
    );

    app.patch("/profile", verifyToken, async (req, res) => {
      try {
        const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
        if (!address || address.length > 500) {
          return res.status(400).send({ success: false, message: "Please enter an address of up to 500 characters" });
        }

        const user = await usersCollection.findOneAndUpdate(
          { _id: new ObjectId(req.user.userId) },
          { $set: { address, updatedAt: new Date() } },
          { returnDocument: "after", projection: { password: 0 } }
        );
        if (!user) return res.status(404).send({ success: false, message: "User not found" });
        return res.send({ success: true, user });
      } catch (error) {
        console.error("Profile address update error:", error);
        return res.status(500).send({ success: false, message: "Unable to save address" });
      }
    });

    app.post("/profile/photo", verifyToken, upload.single("profileImage"), async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).send({ success: false, message: "Please choose an image file" });
        }

        const profileImage = await uploadToCloudinary(req.file.path, "kolystore/profiles");
        const user = await usersCollection.findOneAndUpdate(
          { _id: new ObjectId(req.user.userId) },
          { $set: { profileImage, updatedAt: new Date() } },
          { returnDocument: "after", projection: { password: 0 } }
        );
        if (!user) return res.status(404).send({ success: false, message: "User not found" });
        return res.send({ success: true, user });
      } catch (error) {
        console.error("Profile photo update error:", error);
        return res.status(500).send({ success: false, message: "Unable to save profile photo" });
      }
    });

    // =====================================================
    // CHANGE PASSWORD API
    // =====================================================

    app.post("/change-password", verifyToken, async (req, res) => {
      try {
        const { currentPassword, newPassword, confirmPassword } = req.body || {};

        if (!currentPassword || !newPassword || !confirmPassword) {
          return res.status(400).send({
            success: false,
            message: "Current password, new password, and confirm password are required.",
          });
        }

        if (newPassword !== confirmPassword) {
          return res.status(400).send({
            success: false,
            message: "New password and confirm password do not match.",
          });
        }

        if (String(newPassword).length < 6) {
          return res.status(400).send({
            success: false,
            message: "New password must be at least 6 characters long.",
          });
        }

        const user = await usersCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found.",
          });
        }

        // Verify existing password
        const isCurrentPasswordValid = verifyPassword(currentPassword, user.password);

        if (!isCurrentPasswordValid) {
          return res.status(400).send({
            success: false,
            message: "Incorrect current password. Please try again.",
          });
        }

        // Hash new password
        const newHashedPassword = hashPassword(String(newPassword));

        await usersCollection.updateOne(
          { _id: new ObjectId(req.user.userId) },
          {
            $set: {
              password: newHashedPassword,
              updatedAt: new Date(),
            },
          }
        );

        // Send confirmation email
        if (user.email) {
          void sendEmail({
            to: user.email,
            subject: "Password Changed – KolyStore",
            text:
              `Hello ${user.name || "Customer"},\n\n` +
              `Your KolyStore account password has been successfully updated.\n\n` +
              `If you did not make this change, please contact support immediately.`,
          });
        }

        return res.status(200).send({
          success: true,
          message: "Password updated successfully.",
        });
      } catch (error) {
        console.error("CHANGE PASSWORD ERROR:", error);
        return res.status(500).send({
          success: false,
          message: "Failed to update password. Please try again later.",
        });
      }
    });

// =====================================================
// GET ALL USERS API
// =====================================================
// GET ALL USERS API
// ADMIN ONLY
// =====================================================

app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    // GET ALL USERS EXCEPT ADMIN
    const users = await usersCollection
      .find(
        {
          role: { $ne: "admin" },
        },
        {
          projection: {
            password: 0,
          },
        }
      )
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).send({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    console.error("Get All Customers Error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to get users",
    });
  }
});


// =====================================================
// BLOCK / UNBLOCK USER
// PATCH /admin/users/:id/status
// =====================================================

app.patch(
  "/admin/users/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // CHECK STATUS
      if (!["active", "blocked"].includes(status)) {
        return res.status(400).send({
          success: false,
          message: "Invalid user status",
        });
      }

      // FIND USER
      const user = await usersCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
        });
      }

      // PREVENT ADMIN STATUS CHANGE
      if (
        user.role &&
        user.role.toLowerCase() === "admin"
      ) {
        return res.status(403).send({
          success: false,
          message: "Admin user cannot be blocked",
        });
      }

      // UPDATE STATUS
      const result = await usersCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: {
            status: status,
            updatedAt: new Date(),
          },
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(400).send({
          success: false,
          message: "User status was not updated",
        });
      }

      return res.status(200).send({
        success: true,
        message:
          status === "blocked"
            ? "User blocked successfully"
            : "User unblocked successfully",
        status,
      });
    } catch (error) {
      console.error(
        "Update User Status Error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Failed to update user status",
      });
    }
  }
);



// =====================================================
// DELETE USER
// DELETE /admin/users/:id
// =====================================================

app.delete(
  "/admin/users/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      // FIND USER
      const user = await usersCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
        });
      }

      // PREVENT ADMIN DELETE
      if (
        user.role &&
        user.role.toLowerCase() === "admin"
      ) {
        return res.status(403).send({
          success: false,
          message: "Admin user cannot be deleted",
        });
      }

      // DELETE USER
      const result = await usersCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (result.deletedCount === 0) {
        return res.status(400).send({
          success: false,
          message: "User was not deleted",
        });
      }

      return res.status(200).send({
        success: true,
        message: "User deleted successfully",
        userId: id,
      });
    } catch (error) {
      console.error(
        "Delete User Error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Failed to delete user",
      });
    }
  }
);










    // =====================================================
    // STORE DELIVERY CHARGE
    // =====================================================

    const deliveryChargeSubscribers = new Set();

    const sendDeliveryChargeUpdate = (deliveryCharge) => {
      const message = `data: ${JSON.stringify({ deliveryCharge })}\n\n`;
      for (const subscriber of deliveryChargeSubscribers) {
        subscriber.write(message);
      }
    };

    app.get("/settings/delivery-charge", async (req, res) => {
      try {
        const settings = await storeSettingsCollection.findOne(
          { _id: "shipping" },
          { projection: { deliveryCharge: 1 } }
        );

        return res.send({
          success: true,
          deliveryCharge: Math.max(0, Number(settings?.deliveryCharge) || 0),
        });
      } catch (error) {
        console.error("Get delivery charge error:", error);
        return res.status(500).send({
          success: false,
          message: "Failed to load delivery charge",
        });
      }
    });

    // Keeps the cart and checkout amount current while a customer is already
    // on the page. The browser reconnects automatically if the connection drops.
    app.get("/settings/delivery-charge/stream", async (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write("retry: 3000\n\n");

      deliveryChargeSubscribers.add(res);

      try {
        const settings = await storeSettingsCollection.findOne(
          { _id: "shipping" },
          { projection: { deliveryCharge: 1 } }
        );
        res.write(
          `data: ${JSON.stringify({
            deliveryCharge: Math.max(
              0,
              Number(settings?.deliveryCharge) || 0
            ),
          })}\n\n`
        );
      } catch (error) {
        console.error("Stream delivery charge error:", error);
      }

      req.on("close", () => {
        deliveryChargeSubscribers.delete(res);
        res.end();
      });
    });

    app.put(
      "/admin/settings/delivery-charge",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const deliveryCharge = Number(req.body?.deliveryCharge);
          if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
            return res.status(400).send({
              success: false,
              message: "Delivery charge must be a non-negative number",
            });
          }

          const value = Number(deliveryCharge.toFixed(2));
          await storeSettingsCollection.updateOne(
            { _id: "shipping" },
            {
              $set: {
                deliveryCharge: value,
                updatedAt: new Date(),
                updatedBy: req.user.userId,
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
          );

          sendDeliveryChargeUpdate(value);

          return res.send({ success: true, deliveryCharge: value });
        } catch (error) {
          console.error("Update delivery charge error:", error);
          return res.status(500).send({
            success: false,
            message: "Failed to update delivery charge",
          });
        }
      }
    );

    // =====================================================
    // ADD PRODUCT API
    // =====================================================

   // ============================================================
// ADD PRODUCT API
// ADMIN ONLY
// ============================================================

app.post(
  "/products",
  verifyToken,
  verifyAdmin,
  upload.array("images", 3),
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized access",
        });
      }

      if (
        !req.user.role ||
        req.user.role.toLowerCase() !== "admin"
      ) {
        return res.status(403).send({
          success: false,
          message: "Only admin can add products",
        });
      }

      const {
        productName,
        description,
        category,
        quantity,
        price,
        discount,
        hasSizes,
        sizes,
        hasColors,
        colors,
      } = req.body;

      if (!productName || !productName.trim()) {
        return res.status(400).send({
          success: false,
          message: "Product name is required",
        });
      }

      if (!category || !category.trim()) {
        return res.status(400).send({
          success: false,
          message: "Category is required",
        });
      }

      if (
        quantity === undefined ||
        quantity === null ||
        quantity === ""
      ) {
        return res.status(400).send({
          success: false,
          message: "Quantity is required",
        });
      }

      if (
        price === undefined ||
        price === null ||
        price === ""
      ) {
        return res.status(400).send({
          success: false,
          message: "Price is required",
        });
      }

      const cleanProductName = productName.trim();
      const cleanDescription = description?.trim() || "";
      const cleanCategory = category.trim();

      const allowedCategories = [
        "Seeds",
        "Plants",
        "Vegetables",
        "Toys",
        "Clothes",
        "Cosmetic",
      ];

      if (!allowedCategories.includes(cleanCategory)) {
        return res.status(400).send({
          success: false,
          message: "Invalid category",
        });
      }

      let keyFeatures = [];

      if (req.body.keyFeatures) {
        if (Array.isArray(req.body.keyFeatures)) {
          keyFeatures = req.body.keyFeatures;
        } else {
          keyFeatures = [req.body.keyFeatures];
        }
      }

      keyFeatures = keyFeatures
        .filter(
          (feature) =>
            typeof feature === "string" &&
            feature.trim() !== ""
        )
        .map((feature) => feature.trim());

      const productQuantity = Number(quantity);
      const productPrice = Number(price);
      const productDiscount = Number(discount) || 0;

      if (
        !Number.isFinite(productQuantity) ||
        productQuantity < 0
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid quantity",
        });
      }

      if (
        !Number.isFinite(productPrice) ||
        productPrice < 0
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid price",
        });
      }

      if (
        !Number.isFinite(productDiscount) ||
        productDiscount < 0 ||
        productDiscount > 100
      ) {
        return res.status(400).send({
          success: false,
          message: "Discount must be between 0 and 100",
        });
      }

      let productUnit;

      if (cleanCategory === "Vegetables") {
        productUnit = "kg";
      } else {
        productUnit = "pcs";
      }

      if (
        productUnit === "pcs" &&
        !Number.isInteger(productQuantity)
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Quantity must be a whole number for PCS products",
        });
      }

      const discountedPrice =
        productPrice -
        (productPrice * productDiscount) / 100;

      const images = await Promise.all(
        (req.files || []).map((file) =>
          uploadToCloudinary(file.path, "kolystore/products")
        )
      );

      const productCounter =
        await countersCollection.findOneAndUpdate(
          {
            _id: "productId",
          },
          {
            $inc: {
              sequence: 1,
            },
          },
          {
            upsert: true,
            returnDocument: "after",
          }
        );

      if (
        !productCounter ||
        typeof productCounter.sequence !== "number"
      ) {
        throw new Error(
          "Product ID could not be generated"
        );
      }

      const productNumber = productCounter.sequence;

      const productId = `PRD-${String(
        productNumber
      ).padStart(6, "0")}`;

      const productHasSizes = toBoolean(hasSizes);
      const productHasColors = toBoolean(hasColors);
      const productSizes = productHasSizes
        ? parseStringList(sizes)
        : [];
      const productColors = productHasColors
        ? parseStringList(colors)
        : [];

      if (productHasSizes && productSizes.length === 0) {
        return res.status(400).send({
          success: false,
          message: "Please add at least one size",
        });
      }

      if (productHasColors && productColors.length === 0) {
        return res.status(400).send({
          success: false,
          message: "Please add at least one color",
        });
      }

      const product = {
        productId,
        productNumber,

        productName: cleanProductName,
        description: cleanDescription,
        category: cleanCategory,

        keyFeatures,

        hasSizes: productHasSizes,
        sizes: productSizes,
        hasColors: productHasColors,
        colors: productColors,

        quantity: productQuantity,

        unit: productUnit,

        price: productPrice,

        currency: "EUR",
        currencySymbol: "€",

        discount: productDiscount,

        discountedPrice: Number(
          discountedPrice.toFixed(2)
        ),

        images,

        createdBy: {
          userId: req.user.userId,
          customerId: req.user.customerId,
          email: req.user.email,
          role: req.user.role,
        },

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result =
        await productsCollection.insertOne(product);

      return res.status(201).send({
        success: true,
        message: "Product added successfully",
        product: {
          _id: result.insertedId,
          ...product,
        },
      });
    } catch (error) {
      console.error("Add Product Error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to add product",
      });
    }
  }
); // =====================================================
    // GET ALL PRODUCTS API
    // =====================================================

   app.get("/admin/products", verifyToken, verifyAdmin, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).send({
                success: false,
                message: "Unauthorized access",
            });
        }

        if (
            !req.user.role ||
            req.user.role.toLowerCase() !== "admin"
        ) {
            return res.status(403).send({
                success: false,
                message: "Only admin can access products",
            });
        }

        const products = await productsCollection
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).send({
            success: true,
            count: products.length,
            products,
        });
    } catch (error) {
        console.error("Get Admin Products Error:", error);

        return res.status(500).send({
            success: false,
            message: "Failed to get products",
        });
    }
});


// =====================================================
// GET ALL CATEGORIES API
// =====================================================

app.get("/categories", async (req, res) => {
    try {
        res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
        const categories = [
            "Seeds",
            "Plants",
            "Vegetables",
            "Toys",
            "Clothes",
            "Cosmetic",
        ];

        return res.status(200).send({
            success: true,
            count: categories.length,
            categories,
        });
    } catch (error) {
        console.error("Get Categories Error:", error);

        return res.status(500).send({
            success: false,
            message: "Failed to get categories",
        });
    }
});

app.get("/products", async (req, res) => {
  try {
    const isSummaryRequest = req.query.summary === "1";
    const projection = isSummaryRequest
      ? {
          productName: 1,
          images: 1,
          price: 1,
          discountedPrice: 1,
          discount: 1,
          category: 1,
          productId: 1,
          sku: 1,
          quantity: 1,
          stockStatus: 1,
          createdAt: 1,
        }
      : undefined;

    const products = await productsCollection
      .find({}, projection ? { projection } : {})
      .sort({ createdAt: -1 })
      .toArray();

    // Product cards are public data. Browser/CDN caching makes a repeat visit
    // instant while stale-while-revalidate keeps the list fresh in background.
    if (isSummaryRequest) {
      res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    }

    return res.send({
      success: true,
      count: products.length,
      products,
    });
  } catch (error) {
    console.error("Get Customer Products Error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to get products",
    });
  }
});







    // =====================================================
    // GET MY PRODUCTS API
    // =====================================================

    app.get(
      "/my-products",
      verifyToken,
      async (req, res) => {

        try {

          const products =
            await productsCollection
              .find({
                "createdBy.userId":
                  req.user.userId,
              })
              .sort({
                createdAt: -1,
              })
              .toArray();

          return res.send({
            success: true,

            count:
              products.length,

            products,
          });

        } catch (error) {

          console.error(
            "Get My Products Error:",
            error
          );

          return res.status(500).send({
            success: false,
            message:
              "Failed to get your products",
          });
        }
      }
    );

    // =====================================================
    // GET SINGLE PRODUCT
    // =====================================================

    app.get(
      "/products/:id",
      async (req, res) => {

        try {

          const { id } =
            req.params;

          let product = null;

          if (
            ObjectId.isValid(id)
          ) {
            product =
              await productsCollection.findOne(
                {
                  _id: new ObjectId(
                    id
                  ),
                }
              );
          }

          if (!product) {
            product =
              await productsCollection.findOne(
                {
                  productId: id,
                }
              );
          }

          if (!product) {
            return res.status(404).send({
              success: false,
              message:
                "Product not found",
            });
          }

          return res.send({
            success: true,
            product,
          });

        } catch (error) {

          console.error(
            "Get Product Error:",
            error
          );

          return res.status(500).send({
            success: false,
            message:
              "Failed to get product",
          });
        }
      }
    );

  

    // =====================================================
    // DELETE PRODUCT
    // =====================================================

    app.delete("/admin/products/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).send({
                success: false,
                message: "Product ID is required",
            });
        }

        const { ObjectId } = require("mongodb");

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({
                success: false,
                message: "Invalid product ID",
            });
        }

        const product = await productsCollection.findOne({
            _id: new ObjectId(id),
        });

        if (!product) {
            return res.status(404).send({
                success: false,
                message: "Product not found",
            });
        }

        const result = await productsCollection.deleteOne({
            _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
            return res.status(404).send({
                success: false,
                message: "Product could not be deleted",
            });
        }

        return res.status(200).send({
            success: true,
            message: "Product deleted successfully",
            deletedProduct: product,
        });
    } catch (error) {
        console.error("Delete Product Error:", error);

        return res.status(500).send({
            success: false,
            message: "Failed to delete product",
        });
    }
});



app.patch(
  "/admin/products/:id",
  verifyToken,
  verifyAdmin,

  upload.fields([
    { name: "image1", maxCount: 1 },
    { name: "image2", maxCount: 1 },
    { name: "image3", maxCount: 1 },
  ]),

  async (req, res) => {
    try {
      // =====================================================
      // ADMIN CHECK
      // =====================================================

      if (!req.user) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized access",
        });
      }

      if (
        !req.user.role ||
        req.user.role.toLowerCase() !== "admin"
      ) {
        return res.status(403).send({
          success: false,
          message: "Only admin can edit products",
        });
      }

      // =====================================================
      // PRODUCT ID
      // =====================================================

      const { id } = req.params;

      if (!id) {
        return res.status(400).send({
          success: false,
          message: "Product ID is required",
        });
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid product ID",
        });
      }

      // =====================================================
      // FIND EXISTING PRODUCT
      // =====================================================

      const existingProduct =
        await productsCollection.findOne({
          _id: new ObjectId(id),
        });

      if (!existingProduct) {
        return res.status(404).send({
          success: false,
          message: "Product not found",
        });
      }

      // =====================================================
      // BODY
      // =====================================================

      const {
        productName,
        description,
        category,
        keyFeatures,
        quantity,
        price,
        discount,
        unit,
        hasSizes,
        sizes,
        hasColors,
        colors,
      } = req.body;

      // =====================================================
      // ALLOWED CATEGORIES
      // =====================================================

      const allowedCategories = [
        "Seeds",
        "Plants",
        "Vegetables",
        "Toys",
        "Clothes",
        "Cosmetic",
      ];

      // =====================================================
      // CATEGORY VALIDATION
      // =====================================================

      if (
        category &&
        !allowedCategories.includes(category)
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid product category",
        });
      }

      // =====================================================
      // QUANTITY VALIDATION
      // =====================================================

      if (
        quantity !== undefined &&
        (
          quantity === "" ||
          Number(quantity) < 0 ||
          !Number.isFinite(Number(quantity))
        )
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid quantity",
        });
      }

      // =====================================================
      // PRICE VALIDATION
      // =====================================================

      if (
        price !== undefined &&
        (
          price === "" ||
          Number(price) < 0 ||
          !Number.isFinite(Number(price))
        )
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid price",
        });
      }

      // =====================================================
      // DISCOUNT VALIDATION
      // =====================================================

      if (
        discount !== undefined &&
        (
          discount === "" ||
          Number(discount) < 0 ||
          Number(discount) > 100 ||
          !Number.isFinite(Number(discount))
        )
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Discount must be between 0 and 100",
        });
      }

      // =====================================================
      // FINAL VALUES
      // =====================================================

      const finalPrice =
        price !== undefined
          ? Number(price)
          : Number(existingProduct.price) || 0;

      const finalDiscount =
        discount !== undefined
          ? Number(discount)
          : Number(existingProduct.discount) || 0;

      const finalQuantity =
        quantity !== undefined
          ? Number(quantity)
          : Number(existingProduct.quantity) || 0;

      const finalCategory =
        category || existingProduct.category;

      // =====================================================
      // UNIT
      // =====================================================

      let finalUnit =
        unit ||
        existingProduct.unit ||
        "pcs";

      if (finalCategory === "Vegetables") {
        finalUnit = "kg";
      } else {
        finalUnit = "pcs";
      }

      // =====================================================
      // PCS WHOLE NUMBER
      // =====================================================

      if (
        finalUnit === "pcs" &&
        !Number.isInteger(finalQuantity)
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Quantity must be a whole number for PCS products",
        });
      }

      // =====================================================
      // DISCOUNTED PRICE
      // =====================================================

      const discountedPrice =
        finalPrice -
        (finalPrice * finalDiscount) / 100;

      // =====================================================
      // KEY FEATURES
      // =====================================================

      let finalKeyFeatures =
        existingProduct.keyFeatures || [];

      if (keyFeatures !== undefined) {
        try {
          if (typeof keyFeatures === "string") {
            finalKeyFeatures =
              JSON.parse(keyFeatures);
          } else {
            finalKeyFeatures = keyFeatures;
          }
        } catch (error) {
          finalKeyFeatures =
            existingProduct.keyFeatures || [];
        }

        if (!Array.isArray(finalKeyFeatures)) {
          finalKeyFeatures = [];
        }

        finalKeyFeatures = finalKeyFeatures
          .filter(
            (feature) =>
              typeof feature === "string" &&
              feature.trim() !== ""
          )
          .map((feature) => feature.trim());
      }

      // =====================================================
      // EXISTING IMAGES
      // =====================================================

      let images = [
        ...(existingProduct.images || []),
      ];

      // Keep exactly the existing 3 slots
      while (images.length < 3) {
        images.push(null);
      }

      // =====================================================
      // IMAGE 1
      // =====================================================

      if (
        req.files?.image1 &&
        req.files.image1.length > 0
      ) {
        const file = req.files.image1[0];

        images[0] = await uploadToCloudinary(file.path, "kolystore/products");
      }

      // =====================================================
      // IMAGE 2
      // =====================================================

      if (
        req.files?.image2 &&
        req.files.image2.length > 0
      ) {
        const file = req.files.image2[0];

        images[1] = await uploadToCloudinary(file.path, "kolystore/products");
      }

      // =====================================================
      // IMAGE 3
      // =====================================================

      if (
        req.files?.image3 &&
        req.files.image3.length > 0
      ) {
        const file = req.files.image3[0];

        images[2] = await uploadToCloudinary(file.path, "kolystore/products");
      }

      // =====================================================
      // REMOVE EMPTY IMAGE SLOTS
      // =====================================================

      images = images.filter(Boolean);

      // =====================================================
      // UPDATE DATA
      // =====================================================

      const finalHasSizes =
        hasSizes !== undefined
          ? toBoolean(hasSizes)
          : existingProduct.hasSizes === true;

      const finalSizes = finalHasSizes
        ? parseStringList(
            sizes !== undefined
              ? sizes
              : existingProduct.sizes || []
          )
        : [];

      const finalHasColors =
        hasColors !== undefined
          ? toBoolean(hasColors)
          : existingProduct.hasColors === true;

      const finalColors = finalHasColors
        ? parseStringList(
            colors !== undefined
              ? colors
              : existingProduct.colors || []
          )
        : [];

      if (finalHasSizes && finalSizes.length === 0) {
        return res.status(400).send({
          success: false,
          message: "Please add at least one size",
        });
      }

      if (finalHasColors && finalColors.length === 0) {
        return res.status(400).send({
          success: false,
          message: "Please add at least one color",
        });
      }

      const updateData = {
        updatedAt: new Date(),

        productName:
          productName !== undefined
            ? productName.trim()
            : existingProduct.productName,

        description:
          description !== undefined
            ? description
            : existingProduct.description || "",

        category: finalCategory,

        keyFeatures: finalKeyFeatures,

        hasSizes: finalHasSizes,

        sizes: finalSizes,

        hasColors: finalHasColors,

        colors: finalColors,

        quantity: finalQuantity,

        unit: finalUnit,

        price: finalPrice,

        currency: "EUR",

        currencySymbol: "€",

        discount: finalDiscount,

        discountedPrice: Number(
          discountedPrice.toFixed(2)
        ),

        images: images,
      };

      // =====================================================
      // DATABASE UPDATE
      // =====================================================

      const result =
        await productsCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: updateData,
          }
        );

      // =====================================================
      // GET UPDATED PRODUCT
      // =====================================================

      const updatedProduct =
        await productsCollection.findOne({
          _id: new ObjectId(id),
        });

      console.log(
        "Updated Product Images:",
        updatedProduct.images
      );

      // =====================================================
      // SUCCESS
      // =====================================================

      return res.status(200).send({
        success: true,
        message: "Product updated successfully",
        product: updatedProduct,
      });

    } catch (error) {
      console.error(
        "Edit Product Error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Failed to update product",
      });
    }
  }
);


// =====================================================
// UPDATE PRODUCT STOCK STATUS
// ADMIN ONLY
// =====================================================
// =====================================================
// UPDATE PRODUCT STOCK STATUS
// ADMIN ONLY
// =====================================================

app.patch(
  "/admin/products/:id/stock-status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      // Check login
      if (!req.user) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized access",
        });
      }

      // Check admin
      if (
        !req.user.role ||
        req.user.role.toLowerCase() !== "admin"
      ) {
        return res.status(403).send({
          success: false,
          message: "Only admin can change product stock status",
        });
      }

      const { id } = req.params;

      // Validate ID
      if (!id) {
        return res.status(400).send({
          success: false,
          message: "Product ID is required",
        });
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid product ID",
        });
      }

      // IMPORTANT
      // Prevent req.body undefined error
      const stockStatus = req.body?.stockStatus;

      // Allowed values
      const allowedStockStatus = [
        "in-stock",
        "out-of-stock",
      ];

      if (!allowedStockStatus.includes(stockStatus)) {
        return res.status(400).send({
          success: false,
          message:
            "Stock status must be either in-stock or out-of-stock",
        });
      }

      // Find product
      const existingProduct =
        await productsCollection.findOne({
          _id: new ObjectId(id),
        });

      if (!existingProduct) {
        return res.status(404).send({
          success: false,
          message: "Product not found",
        });
      }

      // Update stock status
      const result =
        await productsCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              stockStatus: stockStatus,
              updatedAt: new Date(),
            },
          }
        );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          success: false,
          message: "Product not found",
        });
      }

      // Get updated product
      const updatedProduct =
        await productsCollection.findOne({
          _id: new ObjectId(id),
        });

      return res.status(200).send({
        success: true,
        message:
          stockStatus === "out-of-stock"
            ? "Product marked as out of stock"
            : "Product marked as in stock",
        stockStatus,
        product: updatedProduct,
      });
    } catch (error) {
      console.error(
        "Stock Status Update Error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Failed to update product stock status",
      });
    }
  }
);

    // =====================================================
    // WISHLIST APIS
    // =====================================================

    app.post(
      "/wishlist",
      verifyToken,
      async (req, res) => {
        try {
          const productId =
            req.body?.productId;

          if (
            !productId ||
            !ObjectId.isValid(productId)
          ) {
            return res.status(400).send({
              success: false,
              message: "Valid product ID is required",
            });
          }

          const product =
            await productsCollection.findOne({
              _id: new ObjectId(productId),
            });

          if (!product) {
            return res.status(404).send({
              success: false,
              message: "Product not found",
            });
          }

          const wishlistItem = {
            userId: req.user.userId,
            customerId: req.user.customerId,
            productId: product._id.toString(),
            product: {
              _id: product._id,
              productId: product.productId,
              productName: product.productName,
              images: product.images || [],
              price: product.price,
              discount: product.discount,
              discountedPrice: product.discountedPrice,
              category: product.category,
            },
            createdAt: new Date(),
          };

          try {
            await wishlistCollection.insertOne(
              wishlistItem
            );
          } catch (error) {
            if (error.code === 11000) {
              return res.send({
                success: true,
                wished: true,
                message: "Product already in wishlist",
              });
            }

            throw error;
          }

          return res.status(201).send({
            success: true,
            wished: true,
            message: "Product added to wishlist",
          });
        } catch (error) {
          console.error("Add Wishlist Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to add to wishlist",
          });
        }
      }
    );

    app.get(
      "/wishlist",
      verifyToken,
      async (req, res) => {
        try {
          const items = await wishlistCollection
            .find({
              userId: req.user.userId,
            })
            .sort({
              createdAt: -1,
            })
            .toArray();

          return res.send({
            success: true,
            count: items.length,
            productIds: items.map(
              (item) => item.productId
            ),
            items,
          });
        } catch (error) {
          console.error("Get Wishlist Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to get wishlist",
          });
        }
      }
    );

    app.delete(
      "/wishlist/:productId",
      verifyToken,
      async (req, res) => {
        try {
          const { productId } = req.params;

          if (!productId) {
            return res.status(400).send({
              success: false,
              message: "Product ID is required",
            });
          }

          const result =
            await wishlistCollection.deleteOne({
              userId: req.user.userId,
              productId: String(productId),
            });

          if (result.deletedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "Wishlist item not found",
            });
          }

          return res.send({
            success: true,
            wished: false,
            message: "Product removed from wishlist",
          });
        } catch (error) {
          console.error(
            "Delete Wishlist Error:",
            error
          );

          return res.status(500).send({
            success: false,
            message: "Failed to remove from wishlist",
          });
        }
      }
    );

    // =====================================================
    // CART APIS  (query by logged-in userId)
    // =====================================================

    const buildCartProduct = (product) => ({
      _id: product._id,
      productId: product.productId,
      productName: product.productName,
      images: product.images || [],
      price: product.price,
      discount: product.discount,
      discountedPrice: product.discountedPrice,
      category: product.category,
      unit: product.unit,
      stock: product.quantity,
      hasColors: product.hasColors === true,
      colors: product.colors || [],
      hasSizes: product.hasSizes === true,
      sizes: product.sizes || [],
    });

    const getCartQuantity = (value, fallback = 1) => {
      const quantity = Number(value);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return fallback;
      }

      return Number(quantity.toFixed(2));
    };

    const getCartOption = (product, value, optionName) => {
      const enabledKey = optionName === "color" ? "hasColors" : "hasSizes";
      const listKey = optionName === "color" ? "colors" : "sizes";
      const options = Array.isArray(product[listKey])
        ? product[listKey].map((option) => String(option).trim()).filter(Boolean)
        : [];
      const selection = String(value || "").trim();

      if (product[enabledKey] === true && options.length > 0) {
        if (!selection) {
          return { value: options[0] };
        }

        if (!options.includes(selection)) {
          return { error: `Please select a valid ${optionName}` };
        }

        return { value: selection };
      }

      return { value: "" };
    };

    app.post(
      "/cart",
      verifyToken,
      async (req, res) => {
        try {
          const productId = req.body?.productId;
          const addQuantity = getCartQuantity(
            req.body?.quantity,
            1
          );

          if (!productId || !ObjectId.isValid(productId)) {
            return res.status(400).send({
              success: false,
              message: "Valid product ID is required",
            });
          }

          const product = await productsCollection.findOne({
            _id: new ObjectId(productId),
          });

          if (!product) {
            return res.status(404).send({
              success: false,
              message: "Product not found",
            });
          }

          const colorResult = getCartOption(
            product,
            req.body?.color,
            "color"
          );
          const sizeResult = getCartOption(product, req.body?.size, "size");

          if (colorResult.error || sizeResult.error) {
            return res.status(400).send({
              success: false,
              message: colorResult.error || sizeResult.error,
            });
          }

          const color = colorResult.value;
          const size = sizeResult.value;

          if (
            product.stockStatus ===
            "out-of-stock"
          ) {
            return res.status(400).send({
              success: false,
              message: "Product is out of stock",
            });
          }

          const stock = Number(product.quantity || 0);

          if (stock <= 0) {
            return res.status(400).send({
              success: false,
              message: "Product is out of stock",
            });
          }

          const userId = req.user.userId;
          const existing = await cartCollection.findOne({
            userId,
            productId: String(productId),
          });

          const nextQuantity = existing
            ? Number(
                (Number(existing.quantity || 0) + addQuantity).toFixed(2)
              )
            : addQuantity;

          const quantity = Math.min(nextQuantity, stock);

          if (existing) {
            await cartCollection.updateOne(
              { _id: existing._id },
              {
                $set: {
                  quantity,
                  color: color || existing.color || "",
                  size: size || existing.size || "",
                  product: buildCartProduct(product),
                  updatedAt: new Date(),
                },
              }
            );
          } else {
            await cartCollection.insertOne({
              userId,
              customerId: req.user.customerId,
              productId: String(productId),
              quantity,
              color,
              size,
              product: buildCartProduct(product),
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }

          const items = await cartCollection
            .find({ userId })
            .sort({ createdAt: -1 })
            .toArray();

          return res.status(existing ? 200 : 201).send({
            success: true,
            message: existing
              ? "Cart updated"
              : "Product added to cart",
            count: items.length,
            items,
          });
        } catch (error) {
          if (error.code === 11000) {
            return res.send({
              success: true,
              message: "Product already in cart",
            });
          }

          console.error("Add Cart Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to add to cart",
          });
        }
      }
    );

    app.get(
      "/cart",
      verifyToken,
      async (req, res) => {
        try {
          const userId = req.user.userId;

          const items = await cartCollection
            .find({ userId })
            .sort({ createdAt: -1 })
            .toArray();

          const productObjectIds = items
            .filter((item) => ObjectId.isValid(item.productId))
            .map((item) => new ObjectId(item.productId));

          const products = productObjectIds.length
            ? await productsCollection
                .find({ _id: { $in: productObjectIds } })
                .toArray()
            : [];

          const productMap = new Map(
            products.map((product) => [
              product._id.toString(),
              product,
            ])
          );

          const mappedItems = items.map((item) => {
            const live = productMap.get(item.productId);

            return {
              ...item,
              available: Boolean(live),
              product: live
                ? buildCartProduct(live)
                : item.product,
            };
          });

          return res.send({
            success: true,
            count: mappedItems.length,
            items: mappedItems,
          });
        } catch (error) {
          console.error("Get Cart Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to get cart",
          });
        }
      }
    );

    app.patch(
      "/cart/:productId",
      verifyToken,
      async (req, res) => {
        try {
          const { productId } = req.params;
          const userId = req.user.userId;
          const hasQuantityUpdate = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "quantity"
          );
          const quantity = hasQuantityUpdate
            ? getCartQuantity(req.body?.quantity, 0)
            : null;
          const hasColorUpdate = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "color"
          );
          const hasSizeUpdate = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "size"
          );

          if (!productId) {
            return res.status(400).send({
              success: false,
              message: "Product ID is required",
            });
          }

          if (hasQuantityUpdate && quantity <= 0) {
            await cartCollection.deleteOne({
              userId,
              productId: String(productId),
            });

            return res.send({
              success: true,
              message: "Product removed from cart",
            });
          }

          const product = ObjectId.isValid(productId)
            ? await productsCollection.findOne({
                _id: new ObjectId(productId),
              })
            : null;

          if (!product) {
            return res.status(404).send({
              success: false,
              message: "Product not found",
            });
          }

          const stock = Number(product.quantity || 0);
          const existing = await cartCollection.findOne({
            userId,
            productId: String(productId),
          });
          const nextQuantity = hasQuantityUpdate
            ? stock > 0
              ? Math.min(quantity, stock)
              : quantity
            : Number(existing?.quantity || 1);
          const colorResult = getCartOption(
            product,
            hasColorUpdate ? req.body.color : existing?.color,
            "color"
          );
          const sizeResult = getCartOption(
            product,
            hasSizeUpdate ? req.body.size : existing?.size,
            "size"
          );

          if (colorResult.error || sizeResult.error) {
            return res.status(400).send({
              success: false,
              message: colorResult.error || sizeResult.error,
            });
          }

          const result = await cartCollection.updateOne(
            {
              userId,
              productId: String(productId),
            },
            {
              $set: {
                quantity: nextQuantity,
                color: colorResult.value,
                size: sizeResult.value,
                updatedAt: new Date(),
                ...(product
                  ? { product: buildCartProduct(product) }
                  : {}),
              },
            }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "Cart item not found",
            });
          }

          return res.send({
            success: true,
            message: "Cart quantity updated",
            quantity: nextQuantity,
          });
        } catch (error) {
          console.error("Update Cart Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to update cart",
          });
        }
      }
    );

    app.delete(
      "/cart/:productId",
      verifyToken,
      async (req, res) => {
        try {
          const { productId } = req.params;
          const userId = req.user.userId;

          if (!productId) {
            return res.status(400).send({
              success: false,
              message: "Product ID is required",
            });
          }

          const cartProductIds = [String(productId)];

          // Older cart records may have stored the product ID as an ObjectId.
          if (ObjectId.isValid(productId)) {
            cartProductIds.push(new ObjectId(productId));
          }

          const result = await cartCollection.deleteOne({
            userId,
            productId: { $in: cartProductIds },
          });

          return res.send({
            success: true,
            message:
              result.deletedCount > 0
                ? "Product removed from cart"
                : "Product was already removed from cart",
          });
        } catch (error) {
          console.error("Delete Cart Error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to remove from cart",
          });
        }
      }
    );

    // =====================================================
    // CREATE ORDER
    // =====================================================

app.post("/orders", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId || !ObjectId.isValid(userId)) {
      return res.status(401).send({
        success: false,
        message: "Invalid user authentication",
      });
    }

    const {
      source = "cart",
      paymentMethod,
      items: requestedItems = [],
      address: submittedAddress = "",
      payment = {},
    } = req.body;

    // =========================================================
    // PAYMENT METHOD VALIDATION
    // =========================================================

    const allowedPaymentMethods = ["paypal"];

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).send({
        success: false,
        message: "Invalid payment method",
      });
    }

    if (
      !payment.transactionId ||
      typeof payment.transactionId !== "string" ||
      !payment.transactionId.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "PayPal transaction ID is required",
      });
    }

    // =========================================================
    // SOURCE VALIDATION
    // =========================================================

    if (!["cart", "single"].includes(source)) {
      return res.status(400).send({
        success: false,
        message: "Invalid order source",
      });
    }

    // =========================================================
    // GET USER
    // =========================================================

    const user = await usersCollection.findOne({
      _id: new ObjectId(userId),
    });

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    // =========================================================
    // ADDRESS
    // =========================================================

    const manualAddress =
      typeof submittedAddress === "string"
        ? submittedAddress.trim()
        : "";

    const savedAddress =
      typeof user.address === "string"
        ? user.address.trim()
        : "";

    const finalAddress = manualAddress || savedAddress;

    if (!finalAddress) {
      return res.status(400).send({
        success: false,
        message: "Please provide your delivery address",
      });
    }

    // =========================================================
    // GET ORDER ITEMS
    // =========================================================

    let orderItems = [];

    if (source === "cart") {
      orderItems = await cartCollection
        .find({ userId })
        .toArray();
    }

    if (source === "single") {
      orderItems = Array.isArray(requestedItems)
        ? requestedItems
        : [];
    }

    if (!orderItems.length) {
      return res.status(400).send({
        success: false,
        message: "No products found for this order",
      });
    }

    // =========================================================
    // GET PRODUCT IDS
    // =========================================================

    const validItems = orderItems.filter((item) =>
      item?.productId &&
      ObjectId.isValid(item.productId)
    );

    if (!validItems.length) {
      return res.status(400).send({
        success: false,
        message: "Invalid product information",
      });
    }

    const productIds = [
      ...new Set(
        validItems.map((item) => item.productId.toString())
      ),
    ].map((id) => new ObjectId(id));

    const products = await productsCollection
      .find({
        _id: { $in: productIds },
      })
      .toArray();

    if (!products.length) {
      return res.status(404).send({
        success: false,
        message: "Products not found",
      });
    }

    // =========================================================
    // HELPER
    // =========================================================

    const getCartOption = (product, selectedValue, type) => {
      if (!selectedValue) return null;

      const options =
        type === "color"
          ? product.colors
          : product.sizes;

      if (!Array.isArray(options)) return null;

      return options.find((option) => {
        if (typeof option === "string") {
          return option === selectedValue;
        }

        return (
          option?.name === selectedValue ||
          option?.value === selectedValue
        );
      });
    };

    // =========================================================
    // CREATE LINE ITEMS
    // =========================================================

    const lineItems = [];

    for (const item of validItems) {
      const product = products.find(
        (p) => p._id.toString() === item.productId.toString()
      );

      if (!product) {
        return res.status(404).send({
          success: false,
          message: `Product not found: ${item.productId}`,
        });
      }

      // -------------------------------------------------------
      // QUANTITY
      // -------------------------------------------------------

      const quantity = Number(item.quantity);
      const unit = String(product.unit || "").trim().toLowerCase();
      const isKgProduct = ["kg", "kilogram", "kilograms"].includes(unit);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        // Non-weight products can only be bought as whole units. KG
        // products use the 0.5 kg steps shown in the cart.
        (!isKgProduct && !Number.isInteger(quantity)) ||
        (isKgProduct && !Number.isInteger(quantity * 2))
      ) {
        return res.status(400).send({
          success: false,
          message: `Invalid quantity for ${product.productName}`,
        });
      }

      // -------------------------------------------------------
      // STOCK
      // -------------------------------------------------------

      if (
        product.stockStatus ===
        "out-of-stock"
      ) {
        return res.status(400).send({
          success: false,
          message: `${product.productName || product.name} is out of stock`,
        });
      }

      // Products store available inventory in `quantity`. For a KG product,
      // this is the available weight in kilograms (for example, 4.5).
      const stock = Number(product.quantity ?? product.stock ?? 0);

      if (stock < quantity) {
        return res.status(400).send({
          success: false,
          message: `${product.productName} does not have enough stock`,
        });
      }

      // -------------------------------------------------------
      // COLOR
      // -------------------------------------------------------

      const selectedColor = item.color || "";

      if (selectedColor) {
        const colorOption = getCartOption(
          product,
          selectedColor,
          "color"
        );

        if (!colorOption) {
          return res.status(400).send({
            success: false,
            message: `Selected color is not available for ${product.name}`,
          });
        }
      }

      // -------------------------------------------------------
      // SIZE
      // -------------------------------------------------------

      const selectedSize = item.size || "";

      if (selectedSize) {
        const sizeOption = getCartOption(
          product,
          selectedSize,
          "size"
        );

        if (!sizeOption) {
          return res.status(400).send({
            success: false,
            message: `Selected size is not available for ${product.name}`,
          });
        }
      }

      // -------------------------------------------------------
      // PRICE
      // -------------------------------------------------------

      const regularPrice = Number(product.price || 0);

      const discount = Number(product.discount || 0);

      const discountedPrice = Number(
        product.discountedPrice || 0
      );

      let unitPrice = regularPrice;

      if (
        discount > 0 &&
        discountedPrice > 0
      ) {
        unitPrice = discountedPrice;
      }

      const itemTotal = unitPrice * quantity;

      // -------------------------------------------------------
      // LINE ITEM
      // -------------------------------------------------------

      lineItems.push({
        productId: product._id,
        name: product.productName || product.name || "",
        image:
          product.image ||
          product.images?.[0] ||
          "",

        quantity,

        price: unitPrice,

        total: itemTotal,

        color: selectedColor,
        size: selectedSize,

        category: product.category || "",

        sku: product.sku || "",
      });
    }

    // =========================================================
    // ORDER TOTAL & SHIPPING FEE (Free shipping over 5 Euros)
    // =========================================================

    const subtotal = lineItems.reduce(
      (sum, item) => sum + Number(item.total || 0),
      0
    );

    if (subtotal <= 0) {
      return res.status(400).send({
        success: false,
        message: "Invalid order total",
      });
    }

    const isFreeShipping = subtotal > 5;
    const shippingSettings = await storeSettingsCollection.findOne(
      { _id: "shipping" },
      { projection: { deliveryCharge: 1 } }
    );
    const globalDeliveryCharge = Math.max(
      0,
      Number(shippingSettings?.deliveryCharge) || 0
    );
    const shippingFee = isFreeShipping ? 0 : globalDeliveryCharge;
    const total = Number((subtotal + shippingFee).toFixed(2));

    // =========================================================
    // PAYPAL
    // =========================================================

    const paymentData = {
      method: "paypal",
      status: "pending",
      transactionId: payment.transactionId.trim(),
      senderName: "",
      proof: "",
      verifiedBy: "",
      verifiedAt: null,
      paidAt: null,
    };

    // =========================================================
    // ORDER ID
    // =========================================================

    const counterResult = await countersCollection.findOneAndUpdate(
      {
        _id: "orderId",
      },
      {
        $inc: {
          sequence: 1,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      }
    );

    // MongoDB driver versions return either the document directly or an
    // object containing it in `value`. Support both so each order receives
    // the incremented counter value instead of repeatedly using 1.
    const counter = counterResult?.value ?? counterResult;
    const sequence = Number(counter?.sequence);

    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new Error("Unable to generate a valid order ID");
    }

    const orderId =
      `ORD-${String(sequence).padStart(6, "0")}`;

    // =========================================================
    // CREATE ORDER
    // =========================================================

    const now = new Date();

    const order = {
      orderId,

      userId,

      customerId: user.customerId || "",

      customer: {
        name: user.name || "",
        email: user.email || "",
        phone: user.phone || "",
        address: finalAddress,
      },

      items: lineItems,

      subtotal: Number(subtotal.toFixed(2)),

      shippingFee: Number(shippingFee.toFixed(2)),

      total,

      paymentMethod,

      paymentStatus: "pending",

      payment: paymentData,

      orderStatus: "pending",

      createdAt: now,

      updatedAt: now,
    };

    // =========================================================
    // INSERT ORDER
    // =========================================================

    const orderResult =
      await ordersCollection.insertOne(order);

    if (!orderResult.insertedId) {
      return res.status(500).send({
        success: false,
        message: "Failed to create order",
      });
    }

    // =========================================================
    // UPDATE STOCK
    // =========================================================

    const stockOperations = lineItems.map((item) => ({
      updateOne: {
        filter: {
          _id: item.productId,
          quantity: {
            $gte: item.quantity,
          },
        },

        update: {
          $inc: {
            quantity: -item.quantity,
          },

          $set: {
            updatedAt: now,
          },
        },
      },
    }));

    if (stockOperations.length) {
      await productsCollection.bulkWrite(
        stockOperations
      );
    }

    // =========================================================
    // SAVE ADDRESS TO USER PROFILE
    // =========================================================

    if (manualAddress && manualAddress !== savedAddress) {
      await usersCollection.updateOne(
        {
          _id: new ObjectId(userId),
        },
        {
          $set: {
            address: finalAddress,
            updatedAt: now,
          },
        }
      );
    }

    // =========================================================
    // CLEAR CART
    // =========================================================

    if (source === "cart") {
      await cartCollection.deleteMany({
        userId,
      });
    }

    // =========================================================
    // ORDER EMAIL (customer + admin)
    // =========================================================

    const itemsSummary = lineItems
      .map((item) => {
        const variant = [item.color, item.size].filter(Boolean).join(", ");
        const variantText = variant ? ` (${variant})` : "";
        const label = item.productName || item.name || "Product";
        return `- ${label}${variantText} × ${item.quantity} — ${item.total}`;
      })
      .join("\n");

    const customerEmail =
      typeof user.email === "string" ? user.email.trim() : "";

   if (customerEmail) {
  void sendEmail({
    to: customerEmail,
    subject: `Order Confirmation ${orderId} – KOLY STORE`,

    text:
      `Hello ${user.name || "Customer"},\n\n` +
      "Thank you for your order! We have received it successfully.\n\n" +
      `Order ID: ${orderId}\n` +
      `Total: ${total}\n` +
      `Payment: ${paymentMethod}\n` +
      `Status: Pending\n\n` +
      `Delivery Address:\n${finalAddress}\n\n` +
      `Items:\n${itemsSummary}\n\n` +
      "We will notify you when your payment is confirmed.\n\n" +
      "Thank you for shopping with KOLY STORE.",

    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      background-color: #f5f7f4;
      font-family: Arial, Helvetica, sans-serif;
    }

    .wrapper {
      width: 100%;
      padding: 35px 15px;
      background-color: #f5f7f4;
    }

    .container {
      width: 100%;
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.07);
    }

    /* Header */
    .header {
      background-color: #498520;
      padding: 30px 20px;
      text-align: center;
    }

    .logo {
      margin: 0;
      color: #ffffff;
      font-size: 27px;
      line-height: 1.3;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .header-text {
      margin: 8px 0 0;
      color: #eaf5e3;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Content */
    .content {
      padding: 35px 30px;
    }

    .success-icon {
      width: 55px;
      height: 55px;
      margin: 0 auto 20px;
      border-radius: 50%;
      background-color: #edf7e8;
      color: #498520;
      font-size: 28px;
      line-height: 55px;
      text-align: center;
    }

    .title {
      margin: 0 0 12px;
      color: #222222;
      font-size: 23px;
      line-height: 1.4;
      text-align: center;
    }

    .intro {
      margin: 0 0 25px;
      color: #555555;
      font-size: 15px;
      line-height: 1.7;
      text-align: center;
    }

    /* Order Summary */
    .order-card {
      margin: 25px 0;
      padding: 22px;
      background-color: #f7faf5;
      border: 1px solid #dcebd4;
      border-radius: 12px;
    }

    .section-title {
      margin: 0 0 18px;
      color: #498520;
      font-size: 17px;
      line-height: 1.4;
      font-weight: 700;
    }

    .row {
      padding: 9px 0;
      border-bottom: 1px solid #e5edde;
      font-size: 14px;
      line-height: 1.6;
    }

    .row:last-child {
      border-bottom: none;
    }

    .label {
      color: #555555;
      font-weight: 600;
    }

    .value {
      color: #222222;
      float: right;
      text-align: right;
      max-width: 60%;
      word-break: break-word;
    }

    .status {
      color: #d97706;
      font-weight: 700;
    }

    /* Address */
    .address-card {
      margin: 25px 0;
      padding: 20px;
      background-color: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
    }

    .address {
      margin: 0;
      color: #555555;
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;
    }

    /* Items */
    .items-card {
      margin: 25px 0;
      padding: 20px;
      background-color: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
    }

    .items {
      margin: 0;
      color: #555555;
      font-size: 14px;
      line-height: 1.7;
      white-space: pre-line;
      word-break: break-word;
    }

    /* Notice */
    .notice {
      margin: 25px 0;
      padding: 16px 18px;
      background-color: #fff8e8;
      border-left: 4px solid #f59e0b;
      border-radius: 6px;
    }

    .notice p {
      margin: 0;
      color: #6b5b35;
      font-size: 13px;
      line-height: 1.6;
    }

    /* Button */
    .button-wrapper {
      margin: 30px 0;
      text-align: center;
    }

    .button {
      display: inline-block;
      padding: 14px 28px;
      background-color: #498520;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 8px;
      font-size: 15px;
      line-height: 1.3;
      font-weight: 600;
    }

    /* Footer */
    .footer {
      padding: 24px 25px;
      background-color: #f8f8f8;
      border-top: 1px solid #eeeeee;
      text-align: center;
    }

    .footer-logo {
      margin: 0 0 8px;
      color: #498520;
      font-size: 17px;
      font-weight: 700;
    }

    .footer-text {
      margin: 0 0 6px;
      color: #888888;
      font-size: 12px;
      line-height: 1.5;
    }

    .copyright {
      margin: 0;
      color: #aaaaaa;
      font-size: 11px;
      line-height: 1.5;
    }

    /* Tablet */
    @media only screen and (max-width: 768px) {
      .wrapper {
        padding: 25px 12px;
      }

      .content {
        padding: 30px 25px;
      }
    }

    /* Mobile */
    @media only screen and (max-width: 480px) {
      .wrapper {
        padding: 10px 5px;
      }

      .container {
        border-radius: 10px;
      }

      .header {
        padding: 24px 15px;
      }

      .logo {
        font-size: 23px;
      }

      .header-text {
        font-size: 12px;
      }

      .content {
        padding: 25px 17px;
      }

      .success-icon {
        width: 48px;
        height: 48px;
        line-height: 48px;
        font-size: 23px;
      }

      .title {
        font-size: 20px;
      }

      .intro {
        font-size: 14px;
      }

      .order-card,
      .address-card,
      .items-card {
        padding: 16px;
      }

      .section-title {
        font-size: 16px;
      }

      .row {
        font-size: 13px;
      }

      .value {
        max-width: 55%;
      }

      .address,
      .items {
        font-size: 13px;
      }

      .button {
        display: block;
        width: 100%;
        padding: 14px 10px;
      }

      .footer {
        padding: 20px 15px;
      }
    }

    /* Small Mobile */
    @media only screen and (max-width: 360px) {
      .content {
        padding: 22px 13px;
      }

      .title {
        font-size: 19px;
      }

      .row {
        font-size: 12px;
      }

      .value {
        max-width: 52%;
      }
    }
  </style>
</head>

<body>

  <div class="wrapper">

    <div class="container">

      <!-- HEADER -->
      <div class="header">

        <h1 class="logo">
          KOLY STORE
        </h1>

        <p class="header-text">
          Your trusted online store
        </p>

      </div>


      <!-- CONTENT -->
      <div class="content">

        <div class="success-icon">
          ✓
        </div>

        <h2 class="title">
          Order Received Successfully!
        </h2>

        <p class="intro">
          Hello <strong>${user.name || "Customer"}</strong>,
          thank you for your order. We have received your order successfully
          and it is now pending payment verification.
        </p>


        <!-- ORDER SUMMARY -->
        <div class="order-card">

          <h3 class="section-title">
            Order Summary
          </h3>

          <div class="row">
            <span class="label">Order ID</span>
            <span class="value">${orderId}</span>
          </div>

          <div class="row">
            <span class="label">Total</span>
            <span class="value">${total}</span>
          </div>

          <div class="row">
            <span class="label">Payment</span>
            <span class="value">${paymentMethod}</span>
          </div>

          <div class="row">
            <span class="label">Status</span>
            <span class="value status">
              Pending
            </span>
          </div>

        </div>


        <!-- DELIVERY ADDRESS -->
        <div class="address-card">

          <h3 class="section-title">
            Delivery Address
          </h3>

          <p class="address">
            ${finalAddress}
          </p>

        </div>


        <!-- ORDER ITEMS -->
        <div class="items-card">

          <h3 class="section-title">
            Order Items
          </h3>

          <p class="items">
            ${itemsSummary}
          </p>

        </div>


        <!-- NOTICE -->
        <div class="notice">

          <p>
            <strong>Payment Verification:</strong>
            We will notify you once your payment has been confirmed.
            Please keep your Order ID for future reference.
          </p>

        </div>


        <!-- BUTTON -->
        <div class="button-wrapper">

          <a
            href="https://kolystore.com"
            class="button"
            target="_blank"
          >
            Visit KOLY STORE
          </a>

        </div>


        <p
          style="
            margin: 0;
            color: #777777;
            font-size: 13px;
            line-height: 1.6;
            text-align: center;
          "
        >
          Thank you for shopping with KOLY STORE.
        </p>

      </div>


      <!-- FOOTER -->
      <div class="footer">

        <p class="footer-logo">
          KOLY STORE
        </p>

        <p class="footer-text">
          Your trusted online store
        </p>

        <p class="copyright">
          © ${new Date().getFullYear()} KOLY STORE.
          All rights reserved.
        </p>

      </div>

    </div>

  </div>

</body>
</html>
    `.trim(),
  });
}

    const adminEmail = await resolveAdminEmail();

if (adminEmail) {
  void sendEmail({
    to: adminEmail,
    subject: `New order ${orderId} – KolyStore`,

    text:
      "A new order has been placed on KolyStore.\n\n" +
      `Order ID: ${orderId}\n` +
      `Customer: ${user.name || "N/A"}\n` +
      `Email: ${user.email || "N/A"}\n` +
      `Phone: ${user.phone || "N/A"}\n` +
      `Address: ${finalAddress || "N/A"}\n` +
      `Payment: ${paymentMethod || "N/A"}\n` +
      `Transaction ID: ${payment.transactionId?.trim() || "N/A"}\n` +
      `Total: ${total}\n\n` +
      `Items:\n${itemsSummary}`,

    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>New Order - KolyStore</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f4f7f2;
    font-family:Arial,Helvetica,sans-serif;
    color:#1f2937;
  "
>

<table
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    width:100%;
    background:#f4f7f2;
    padding:12px 8px;
  "
>
  <tr>
    <td align="center">

      <!-- MAIN CARD -->
      <table
        width="100%"
        cellpadding="0"
        cellspacing="0"
        border="0"
        style="
          width:100%;
          max-width:560px;
          background:#ffffff;
          border-radius:10px;
          overflow:hidden;
          border:1px solid #e5e7eb;
        "
      >

        <!-- HEADER -->
        <tr>
          <td
            style="
              background:#498520;
              padding:18px 15px;
              text-align:center;
            "
          >

            <div
              style="
                font-size:22px;
                line-height:1.2;
                font-weight:700;
                color:#ffffff;
              "
            >
              KolyStore
            </div>

            <div
              style="
                margin-top:4px;
                font-size:11px;
                line-height:1.4;
                color:#eaf5e4;
              "
            >
              Order Management System
            </div>

          </td>
        </tr>


        <!-- CONTENT -->
        <tr>
          <td
            style="
              padding:20px 15px;
            "
          >

            <!-- TITLE -->
            <h1
              style="
                margin:0;
                padding:0;
                font-size:20px;
                line-height:1.3;
                font-weight:700;
                color:#111827;
              "
            >
              New Order Received
            </h1>

            <p
              style="
                margin:6px 0 16px;
                padding:0;
                font-size:12px;
                line-height:1.5;
                color:#6b7280;
              "
            >
              A new order has been successfully placed on KolyStore.
            </p>


            <!-- ORDER ID -->
            <table
              width="100%"
              cellpadding="0"
              cellspacing="0"
              border="0"
              style="
                width:100%;
                background:#f8faf7;
                border:1px solid #e2eadf;
                border-radius:8px;
              "
            >
              <tr>
                <td
                  style="
                    padding:10px 12px;
                    font-size:10px;
                    font-weight:700;
                    color:#6b7280;
                    text-transform:uppercase;
                    letter-spacing:.6px;
                    white-space:nowrap;
                    width:25%;
                  "
                >
                  Order ID
                </td>

                <td
                  style="
                    padding:10px 12px;
                    font-size:12px;
                    font-weight:700;
                    color:#498520;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                  "
                >
                  ${orderId || "N/A"}
                </td>
              </tr>
            </table>


            <!-- CUSTOMER INFORMATION -->
            <table
              width="100%"
              cellpadding="0"
              cellspacing="0"
              border="0"
              style="
                width:100%;
                margin-top:12px;
                table-layout:fixed;
                border:1px solid #e5e7eb;
                border-radius:8px;
                overflow:hidden;
              "
            >

              <!-- HEADER -->
              <tr>
                <td
                  colspan="2"
                  style="
                    padding:10px 12px;
                    background:#f8faf7;
                    border-bottom:1px solid #e5e7eb;
                    font-size:12px;
                    font-weight:700;
                    color:#374151;
                  "
                >
                  Customer Information
                </td>
              </tr>


              <!-- CUSTOMER -->
              <tr>

                <td
                  width="27%"
                  style="
                    width:27%;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Customer
                </td>

                <td
                  width="73%"
                  style="
                    width:73%;
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${user.name || "N/A"}
                </td>

              </tr>


              <!-- EMAIL -->
              <tr>

                <td
                  style="
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Email
                </td>

                <td
                  style="
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${user.email || "N/A"}
                </td>

              </tr>


              <!-- PHONE -->
              <tr>

                <td
                  style="
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Phone
                </td>

                <td
                  style="
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${user.phone || "N/A"}
                </td>

              </tr>


              <!-- ADDRESS -->
              <tr>

                <td
                  style="
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Address
                </td>

                <td
                  style="
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${finalAddress || "N/A"}
                </td>

              </tr>


              <!-- PAYMENT -->
              <tr>

                <td
                  style="
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Payment
                </td>

                <td
                  style="
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${paymentMethod || "N/A"}
                </td>

              </tr>


              <!-- TRANSACTION -->
              <tr>

                <td
                  style="
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Transaction ID
                </td>

                <td
                  style="
                    max-width:0;
                    padding:8px 10px;
                    font-size:11px;
                    line-height:1.3;
                    font-weight:600;
                    color:#111827;
                    border-bottom:1px solid #f0f0f0;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${payment.transactionId?.trim() || "N/A"}
                </td>

              </tr>


              <!-- TOTAL -->
              <tr>

                <td
                  style="
                    padding:9px 10px;
                    font-size:11px;
                    line-height:1.3;
                    color:#6b7280;
                    white-space:nowrap;
                    vertical-align:middle;
                  "
                >
                  Total
                </td>

                <td
                  style="
                    max-width:0;
                    padding:9px 10px;
                    font-size:13px;
                    line-height:1.3;
                    font-weight:700;
                    color:#498520;
                    white-space:nowrap;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    vertical-align:middle;
                  "
                >
                  ${total}
                </td>

              </tr>

            </table>


            <!-- ORDER ITEMS -->
            <table
              width="100%"
              cellpadding="0"
              cellspacing="0"
              border="0"
              style="
                width:100%;
                margin-top:12px;
                border:1px solid #e5e7eb;
                border-radius:8px;
                overflow:hidden;
              "
            >

              <tr>
                <td
                  style="
                    padding:10px 12px;
                    background:#f8faf7;
                    border-bottom:1px solid #e5e7eb;
                    font-size:12px;
                    font-weight:700;
                    color:#374151;
                  "
                >
                  Order Items
                </td>
              </tr>

              <tr>
                <td
                  style="
                    padding:10px 12px;
                    font-size:11px;
                    line-height:1.5;
                    color:#4b5563;
                    white-space:pre-line;
                    overflow-wrap:anywhere;
                  "
                >
                  ${itemsSummary}
                </td>
              </tr>

            </table>


            <!-- NOTICE -->
            <table
              width="100%"
              cellpadding="0"
              cellspacing="0"
              border="0"
              style="
                width:100%;
                margin-top:12px;
                background:#f8faf7;
                border-left:3px solid #498520;
                border-radius:5px;
              "
            >
              <tr>
                <td
                  style="
                    padding:10px 12px;
                    font-size:10px;
                    line-height:1.5;
                    color:#6b7280;
                  "
                >
                  This is an automated order notification from
                  KolyStore. Please review the order details and
                  process the order accordingly.
                </td>
              </tr>
            </table>

          </td>
        </tr>


        <!-- FOOTER -->
        <tr>
          <td
            style="
              padding:13px 12px;
              background:#f8faf7;
              text-align:center;
              border-top:1px solid #edf0eb;
            "
          >

            <p
              style="
                margin:0;
                font-size:10px;
                line-height:1.5;
                color:#6b7280;
              "
            >
              © ${new Date().getFullYear()} KolyStore.
              All rights reserved.
            </p>

            <p
              style="
                margin:3px 0 0;
                font-size:9px;
                line-height:1.4;
                color:#9ca3af;
              "
            >
              Automated Order Notification
            </p>

          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>
    `,
  });
} else {
  console.warn(
    "Admin order notification skipped: no admin email in users collection"
  );
}
    // =========================================================
    // RESPONSE
    // =========================================================

    res.status(201).send({
      success: true,

      orderId,

      userId,

      paymentMethod,

      paymentStatus: "pending",

      total,

      message:
        "Order placed successfully. Your PayPal payment is pending verification.",
    });

  } catch (error) {
    console.error("ORDER CREATE ERROR:", error);

    res.status(500).send({
      success: false,
      message: "Failed to place order",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
});



app.get("/customer-only", verifyToken, async (req, res) => {
  try {
    // Logged-in user ID & email
    const userId = req.user?.userId;
    const userEmail = req.user?.email;

    if (!userId) {
      return res.status(401).send({
        success: false,
        message: "Invalid user authentication",
      });
    }

    const queryFilter = {
      $or: [
        { userId: userId },
        { userId: String(userId) },
        ...(userEmail ? [{ "customer.email": userEmail }] : []),
        ...(userEmail ? [{ email: userEmail }] : []),
      ],
    };

    // Get user's orders
    const orders = await ordersCollection
      .find(queryFilter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).send({
      success: true,
      message: "Customer orders loaded successfully",
      userId: userId,
      count: orders.length,
      orders: orders,
    });
  } catch (error) {
    console.error("CUSTOMER ORDERS ERROR:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to get customer orders",
      error: error.message,
    });
  }
});







    // =========================================================
// ADMIN - GET ALL ORDERS
// =========================================================

app.get("/admin/orders", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const userId = req.user.userId;

        // =====================================================
        // VALIDATE USER
        // =====================================================

        if (!userId || !ObjectId.isValid(userId)) {
            return res.status(401).send({
                success: false,
                message: "Invalid user authentication",
            });
        }

        // =====================================================
        // GET LOGGED-IN USER
        // =====================================================

        const admin = await usersCollection.findOne({
            _id: new ObjectId(userId),
        });

        if (!admin) {
            return res.status(404).send({
                success: false,
                message: "User not found",
            });
        }

        // =====================================================
        // ADMIN CHECK
        // =====================================================

        if (
            !admin.role ||
            admin.role.toLowerCase() !== "admin"
        ) {
            return res.status(403).send({
                success: false,
                message: "Only admin can access orders",
            });
        }

        // =====================================================
        // GET ALL ORDERS
        // =====================================================

        const orders = await ordersCollection
            .find({})
            .sort({
                createdAt: -1,
            })
            .toArray();

        // =====================================================
        // RESPONSE
        // =====================================================

        res.status(200).send({
            success: true,
            count: orders.length,
            orders,
        });
    } catch (error) {
        console.error(
            "ADMIN GET ALL ORDERS ERROR:",
            error
        );

        res.status(500).send({
            success: false,
            message: "Failed to get orders",
            error:
                process.env.NODE_ENV === "development"
                    ? error.message
                    : undefined,
        });
    }
});

// =========================================================
// ADMIN - UPDATE ORDER STATUS
// PATCH /admin/orders/:id/status
// =========================================================

app.patch(
    "/admin/orders/:id/status",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            if (
                !req.user?.role ||
                req.user.role.toLowerCase() !== "admin"
            ) {
                return res.status(403).send({
                    success: false,
                    message: "Only admin can update order status",
                });
            }

            const { id } = req.params;

            const orderStatus = String(
                req.body?.orderStatus ||
                    req.body?.status ||
                    ""
            )
                .trim()
                .toLowerCase();

            const allowedStatuses = [
                "pending",
                "confirmed",
                "processing",
                "shipped",
                "delivered",
                "completed",
                "cancelled",
                "canceled",
            ];

            if (!allowedStatuses.includes(orderStatus)) {
                return res.status(400).send({
                    success: false,
                    message: "Invalid order status",
                });
            }

            if (!id || !ObjectId.isValid(id)) {
                return res.status(400).send({
                    success: false,
                    message: "Invalid order ID",
                });
            }

            const order = await ordersCollection.findOne({
                _id: new ObjectId(id),
            });

            if (!order) {
                return res.status(404).send({
                    success: false,
                    message: "Order not found",
                });
            }

            const now = new Date();

            const result = await ordersCollection.updateOne(
                {
                    _id: new ObjectId(id),
                },
                {
                    $set: {
                        orderStatus,
                        status: orderStatus,
                        updatedAt: now,
                    },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).send({
                    success: false,
                    message: "Order not found",
                });
            }

            const normalizeOrderStatus = (value) => {
                const status = String(value || "")
                    .trim()
                    .toLowerCase();
                return status === "canceled" ? "cancelled" : status;
            };

            const formatStatusLabel = (value) => {
                const normalized = normalizeOrderStatus(value);
                return (
                    normalized.charAt(0).toUpperCase() +
                    normalized.slice(1)
                );
            };

            const previousStatus = normalizeOrderStatus(
                order.orderStatus || order.status
            );
            const nextStatus = normalizeOrderStatus(orderStatus);

            if (previousStatus !== nextStatus) {
                let customerEmail =
                    typeof order.customer?.email === "string"
                        ? order.customer.email.trim()
                        : "";
                let customerName =
                    typeof order.customer?.name === "string"
                        ? order.customer.name.trim()
                        : "";

                if (
                    !customerEmail &&
                    order.userId &&
                    ObjectId.isValid(String(order.userId))
                ) {
                    const customer = await usersCollection.findOne(
                        {
                            _id: new ObjectId(
                                String(order.userId)
                            ),
                        },
                        {
                            projection: {
                                email: 1,
                                name: 1,
                            },
                        }
                    );

                    if (
                        typeof customer?.email === "string"
                    ) {
                        customerEmail = customer.email.trim();
                    }
                    if (
                        !customerName &&
                        typeof customer?.name === "string"
                    ) {
                        customerName = customer.name.trim();
                    }
                }

             if (customerEmail) {
  void sendEmail({
    to: customerEmail,
    subject: `Order ${order.orderId || id} Update – KOLY STORE`,

    text:
      `Hello ${customerName || "Customer"},\n\n` +
      "Your order status has been updated.\n\n" +
      `Order ID: ${order.orderId || id}\n` +
      `Previous Status: ${formatStatusLabel(previousStatus)}\n` +
      `Current Status: ${formatStatusLabel(nextStatus)}\n\n` +
      "Thank you for shopping with KOLY STORE.",

    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      background-color: #f5f7f4;
      font-family: Arial, Helvetica, sans-serif;
    }

    .wrapper {
      width: 100%;
      padding: 35px 15px;
      background-color: #f5f7f4;
    }

    .container {
      width: 100%;
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.07);
    }

    /* Header */
    .header {
      padding: 30px 20px;
      background-color: #498520;
      text-align: center;
    }

    .logo {
      margin: 0;
      color: #ffffff;
      font-size: 27px;
      line-height: 1.3;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .header-text {
      margin: 8px 0 0;
      color: #eaf5e3;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Content */
    .content {
      padding: 35px 30px;
    }

    .update-icon {
      width: 55px;
      height: 55px;
      margin: 0 auto 20px;
      border-radius: 50%;
      background-color: #edf7e8;
      color: #498520;
      font-size: 27px;
      line-height: 55px;
      text-align: center;
      font-weight: 700;
    }

    .title {
      margin: 0 0 12px;
      color: #222222;
      font-size: 23px;
      line-height: 1.4;
      text-align: center;
    }

    .intro {
      margin: 0 0 25px;
      color: #555555;
      font-size: 15px;
      line-height: 1.7;
      text-align: center;
    }

    /* Order Card */
    .order-card {
      margin: 25px 0;
      padding: 22px;
      background-color: #f7faf5;
      border: 1px solid #dcebd4;
      border-radius: 12px;
    }

    .section-title {
      margin: 0 0 18px;
      color: #498520;
      font-size: 17px;
      line-height: 1.4;
      font-weight: 700;
    }

    .order-id {
      margin: 0;
      padding: 12px 14px;
      background-color: #ffffff;
      border-radius: 8px;
      color: #222222;
      font-size: 14px;
      line-height: 1.5;
      word-break: break-word;
    }

    /* Status */
    .status-container {
      margin: 25px 0;
    }

    .status-box {
      width: 100%;
      padding: 18px;
      border-radius: 10px;
      text-align: center;
    }

    .previous {
      background-color: #f5f5f5;
      border: 1px solid #e5e5e5;
    }

    .current {
      margin-top: 12px;
      background-color: #edf7e8;
      border: 1px solid #cfe5c5;
    }

    .status-label {
      margin: 0 0 7px;
      color: #777777;
      font-size: 12px;
      line-height: 1.4;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .status-value {
      margin: 0;
      color: #333333;
      font-size: 15px;
      line-height: 1.5;
      font-weight: 700;
      word-break: break-word;
    }

    .current .status-value {
      color: #498520;
    }

    .arrow {
      margin: 10px 0;
      color: #498520;
      font-size: 20px;
      text-align: center;
    }

    /* Notice */
    .notice {
      margin: 25px 0;
      padding: 16px 18px;
      background-color: #f7faf5;
      border-left: 4px solid #498520;
      border-radius: 6px;
    }

    .notice p {
      margin: 0;
      color: #5f665c;
      font-size: 13px;
      line-height: 1.7;
    }

    /* Button */
    .button-wrapper {
      margin: 30px 0;
      text-align: center;
    }

    .button {
      display: inline-block;
      padding: 14px 28px;
      background-color: #498520;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 8px;
      font-size: 15px;
      line-height: 1.3;
      font-weight: 600;
    }

    /* Footer */
    .footer {
      padding: 24px 25px;
      background-color: #f8f8f8;
      border-top: 1px solid #eeeeee;
      text-align: center;
    }

    .footer-logo {
      margin: 0 0 8px;
      color: #498520;
      font-size: 17px;
      line-height: 1.4;
      font-weight: 700;
    }

    .footer-text {
      margin: 0 0 6px;
      color: #888888;
      font-size: 12px;
      line-height: 1.5;
    }

    .copyright {
      margin: 0;
      color: #aaaaaa;
      font-size: 11px;
      line-height: 1.5;
    }

    /* Tablet */
    @media only screen and (max-width: 768px) {
      .wrapper {
        padding: 25px 12px;
      }

      .content {
        padding: 30px 25px;
      }
    }

    /* Mobile */
    @media only screen and (max-width: 480px) {
      .wrapper {
        padding: 10px 5px;
      }

      .container {
        border-radius: 10px;
      }

      .header {
        padding: 24px 15px;
      }

      .logo {
        font-size: 23px;
      }

      .header-text {
        font-size: 12px;
      }

      .content {
        padding: 25px 17px;
      }

      .update-icon {
        width: 48px;
        height: 48px;
        line-height: 48px;
        font-size: 23px;
      }

      .title {
        font-size: 20px;
      }

      .intro {
        font-size: 14px;
      }

      .order-card {
        padding: 17px;
      }

      .section-title {
        font-size: 16px;
      }

      .status-box {
        padding: 16px 12px;
      }

      .status-value {
        font-size: 14px;
      }

      .button {
        display: block;
        width: 100%;
        padding: 14px 10px;
      }

      .footer {
        padding: 20px 15px;
      }
    }

    /* Small Mobile */
    @media only screen and (max-width: 360px) {
      .content {
        padding: 22px 13px;
      }

      .title {
        font-size: 19px;
      }

      .intro {
        font-size: 13px;
      }

      .order-id,
      .status-value {
        font-size: 12px;
      }
    }
  </style>
</head>

<body>

  <div class="wrapper">

    <div class="container">

      <!-- HEADER -->
      <div class="header">

        <h1 class="logo">
          KOLY STORE
        </h1>

        <p class="header-text">
          Your trusted online store
        </p>

      </div>


      <!-- CONTENT -->
      <div class="content">

        <div class="update-icon">
          ✓
        </div>

        <h2 class="title">
          Order Status Updated
        </h2>

        <p class="intro">
          Hello <strong>${customerName || "Customer"}</strong>,
          your order status has been successfully updated.
        </p>


        <!-- ORDER INFORMATION -->
        <div class="order-card">

          <h3 class="section-title">
            Order Information
          </h3>

          <p class="order-id">
            <strong>Order ID:</strong>
            ${order.orderId || id}
          </p>

        </div>


        <!-- STATUS CHANGE -->
        <div class="status-container">

          <div class="status-box previous">

            <p class="status-label">
              Previous Status
            </p>

            <p class="status-value">
              ${formatStatusLabel(previousStatus)}
            </p>

          </div>

          <div class="arrow">
            ↓
          </div>

          <div class="status-box current">

            <p class="status-label">
              Current Status
            </p>

            <p class="status-value">
              ${formatStatusLabel(nextStatus)}
            </p>

          </div>

        </div>


        <!-- NOTICE -->
        <div class="notice">

          <p>
            Your order is being processed according to the updated status.
            We will keep you informed about any further updates.
          </p>

        </div>


        <!-- BUTTON -->
        <div class="button-wrapper">

          <a
            href="https://kolystore.com"
            class="button"
            target="_blank"
          >
            Visit KOLY STORE
          </a>

        </div>


        <p
          style="
            margin: 0;
            color: #777777;
            font-size: 13px;
            line-height: 1.6;
            text-align: center;
          "
        >
          Thank you for shopping with KOLY STORE.
        </p>

      </div>


      <!-- FOOTER -->
      <div class="footer">

        <p class="footer-logo">
          KOLY STORE
        </p>

        <p class="footer-text">
          Your trusted online store
        </p>

        <p class="copyright">
          © ${new Date().getFullYear()} KOLY STORE.
          All rights reserved.
        </p>

      </div>

    </div>

  </div>

</body>
</html>
    `.trim(),
  });
}
            }

            return res.status(200).send({
                success: true,
                message: "Order status updated successfully",
                orderStatus,
                updatedAt: now,
            });
        } catch (error) {
            console.error(
                "ADMIN UPDATE ORDER STATUS ERROR:",
                error
            );

            return res.status(500).send({
                success: false,
                message: "Failed to update order status",
                error:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        }
    }
);

// =========================================================
// ADMIN - DELETE ORDER + RESTORE STOCK
// DELETE /admin/orders/:id
// =========================================================

app.delete(
    "/admin/orders/:id",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            if (
                !req.user?.role ||
                req.user.role.toLowerCase() !== "admin"
            ) {
                return res.status(403).send({
                    success: false,
                    message: "Only admin can delete orders",
                });
            }

            const { id } = req.params;

            if (!id || !ObjectId.isValid(id)) {
                return res.status(400).send({
                    success: false,
                    message: "Invalid order ID",
                });
            }

            const order = await ordersCollection.findOne({
                _id: new ObjectId(id),
            });

            if (!order) {
                return res.status(404).send({
                    success: false,
                    message: "Order not found",
                });
            }

            const items = Array.isArray(order.items)
                ? order.items
                : Array.isArray(order.products)
                ? order.products
                : [];

            const now = new Date();

            const stockOperations = items
                .map((item) => {
                    const productId = item?.productId;

                    if (
                        !productId ||
                        !ObjectId.isValid(
                            String(productId)
                        )
                    ) {
                        return null;
                    }

                    const quantity = Number(
                        item?.quantity
                    );

                    if (
                        !Number.isFinite(quantity) ||
                        quantity <= 0
                    ) {
                        return null;
                    }

                    return {
                        updateOne: {
                            filter: {
                                _id: new ObjectId(
                                    String(productId)
                                ),
                            },
                            update: {
                                $inc: {
                                    quantity,
                                },
                                $set: {
                                    updatedAt: now,
                                },
                            },
                        },
                    };
                })
                .filter(Boolean);

            if (stockOperations.length) {
                await productsCollection.bulkWrite(
                    stockOperations
                );
            }

            const deleteResult =
                await ordersCollection.deleteOne({
                    _id: new ObjectId(id),
                });

            if (deleteResult.deletedCount === 0) {
                return res.status(404).send({
                    success: false,
                    message: "Order could not be deleted",
                });
            }

            return res.status(200).send({
                success: true,
                message:
                    "Order deleted and product stock restored successfully",
                restoredItems: stockOperations.length,
            });
        } catch (error) {
            console.error(
                "ADMIN DELETE ORDER ERROR:",
                error
            );

            return res.status(500).send({
                success: false,
                message: "Failed to delete order",
                error:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        }
    }
);

    // =====================================================
    // ADMIN - DASHBOARD STATS (visitor timezone)
    // =====================================================

    const resolveVisitorTimeZone = (value) => {
      const fallback = "UTC";

      if (!value || typeof value !== "string") {
        return fallback;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return fallback;
      }

      try {
        Intl.DateTimeFormat(undefined, {
          timeZone: trimmed,
        }).format(new Date());
        return trimmed;
      } catch {
        return fallback;
      }
    };

    const getDateKeyInTimeZone = (date, timeZone) => {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    };

    const getZonedCalendarParts = (date, timeZone) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(date);

      const read = (type) =>
        Number(parts.find((part) => part.type === type)?.value);

      return {
        year: read("year"),
        month: read("month"),
        day: read("day"),
      };
    };

    app.get("/admin/dashboard", verifyToken, verifyAdmin, async (req, res) => {
      try {
        if (
          !req.user?.role ||
          req.user.role.toLowerCase() !== "admin"
        ) {
          return res.status(403).send({
            success: false,
            message: "Only admin can access dashboard",
          });
        }

        const normalizeOrderStatus = (value) => {
          const status = String(value || "")
            .trim()
            .toLowerCase();
          return status === "canceled" ? "cancelled" : status;
        };

        const isCancelledStatus = (order) => {
          const status = normalizeOrderStatus(
            order?.orderStatus || order?.status
          );
          return status === "cancelled";
        };

        // Dashboard sales represent product revenue only; delivery fees are
        // deliberately excluded from every sales card and chart.
        const getOrderProductTotal = (order) => {
          const subtotal = Number(order?.subtotal);
          if (Number.isFinite(subtotal)) {
            return Math.max(0, subtotal);
          }

          // Support older orders that were saved before `subtotal` existed.
          if (Array.isArray(order?.items) && order.items.length > 0) {
            return order.items.reduce((sum, item) => {
              const lineTotal = Number(item?.total);
              if (Number.isFinite(lineTotal)) {
                return sum + Math.max(0, lineTotal);
              }

              const price = Number(item?.price);
              const quantity = Number(item?.quantity);
              return sum +
                (Number.isFinite(price) && Number.isFinite(quantity)
                  ? Math.max(0, price * quantity)
                  : 0);
            }, 0);
          }

          const total = Number(order?.total);
          const shippingFee = Number(order?.shippingFee);
          if (Number.isFinite(total) && Number.isFinite(shippingFee)) {
            return Math.max(0, total - shippingFee);
          }

          return 0;
        };

        const getOrderDate = (order) => {
          const raw = order?.createdAt;
          if (!raw) return null;
          const date = raw instanceof Date ? raw : new Date(raw);
          return Number.isNaN(date.getTime()) ? null : date;
        };

        const timeZone = resolveVisitorTimeZone(req.query.timezone);

        const now = new Date();
        const nowInZone = getZonedCalendarParts(now, timeZone);
        const currentYear = nowInZone.year;
        const currentMonth = nowInZone.month;
        const todayKey = getDateKeyInTimeZone(now, timeZone);
        const currentMonthKey = todayKey.slice(0, 7);

        const daysInCurrentMonth = new Date(
          currentYear,
          currentMonth,
          0
        ).getDate();

        const monthLabels = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];

        const [
          totalUsers,
          activeUsers,
          totalProducts,
          allOrders,
        ] = await Promise.all([
          usersCollection.countDocuments({
            role: { $ne: "admin" },
          }),
          usersCollection.countDocuments({
            role: { $ne: "admin" },
            status: { $ne: "blocked" },
          }),
          productsCollection.countDocuments({}),
          ordersCollection
            .find(
              {},
              {
                projection: {
                  total: 1,
                  subtotal: 1,
                  shippingFee: 1,
                  items: 1,
                  createdAt: 1,
                  userId: 1,
                  customer: 1,
                  orderStatus: 1,
                  status: 1,
                },
              }
            )
            .toArray(),
        ]);

        const orderStatusCounts = {
          pending: 0,
          confirmed: 0,
          processing: 0,
          shipped: 0,
          delivered: 0,
          completed: 0,
          cancelled: 0,
        };

        let todaySales = 0;
        let monthSales = 0;
        let yearSales = 0;
        let totalSales = 0;
        const todayCustomerIds = new Set();

        const monthlySalesMap = Array.from({ length: 12 }, (_, index) => ({
          month: monthLabels[index],
          sales: 0,
        }));

        const dailySalesMap = Array.from(
          { length: daysInCurrentMonth },
          (_, index) => ({
            day: index + 1,
            sales: 0,
          })
        );

        const numberOfWeeks = Math.ceil(daysInCurrentMonth / 7);
        const weeklySalesMap = Array.from(
          { length: numberOfWeeks },
          (_, index) => ({
            week: `Week ${index + 1}`,
            sales: 0,
          })
        );

        for (const order of allOrders) {
          const status = normalizeOrderStatus(
            order?.orderStatus || order?.status || "pending"
          );

          if (orderStatusCounts[status] !== undefined) {
            orderStatusCounts[status] += 1;
          } else {
            orderStatusCounts.pending += 1;
          }

          const createdAt = getOrderDate(order);

          // Track today's unique customers as soon as an order is placed (non-cancelled)
          if (createdAt && status !== "cancelled") {
            const orderKey = getDateKeyInTimeZone(createdAt, timeZone);
            if (orderKey === todayKey) {
              const customerId = order.userId
                ? String(order.userId)
                : order.customer?.email
                ? String(order.customer.email).trim().toLowerCase()
                : order.customer?.phone
                ? String(order.customer.phone).trim()
                : null;
              if (customerId) {
                todayCustomerIds.add(customerId);
              }
            }
          }

          if (isCancelledStatus(order)) {
            continue;
          }

          const total = getOrderProductTotal(order);

          totalSales += total;

          if (!createdAt) {
            continue;
          }

          const orderKey = getDateKeyInTimeZone(createdAt, timeZone);
          const orderParts = getZonedCalendarParts(
            createdAt,
            timeZone
          );

          if (orderKey === todayKey) {
            todaySales += total;
          }

          if (orderKey.slice(0, 7) === currentMonthKey) {
            monthSales += total;

            const dayIndex = orderParts.day - 1;
            if (dayIndex >= 0 && dayIndex < dailySalesMap.length) {
              dailySalesMap[dayIndex].sales += total;
            }

            const weekIndex = Math.floor((orderParts.day - 1) / 7);
            const safeWeekIndex = Math.min(
              weekIndex,
              weeklySalesMap.length - 1
            );
            weeklySalesMap[safeWeekIndex].sales += total;
          }

          if (orderParts.year === currentYear) {
            yearSales += total;
            const monthIndex = orderParts.month - 1;
            if (monthIndex >= 0 && monthIndex < 12) {
              monthlySalesMap[monthIndex].sales += total;
            }
          }
        }

        return res.status(200).send({
          success: true,
          stats: {
            totalUsers,
            totalProducts,
            todaySales,
            todayCustomers: todayCustomerIds.size,
            monthSales,
            yearSales,
            totalSales,
            activeUsers,
          },
          orderStatuses: orderStatusCounts,
          monthlySales: monthlySalesMap,
          weeklySales: weeklySalesMap,
          dailySales: dailySalesMap,
          meta: {
            currentYear,
            currentMonthName: now.toLocaleString("de-DE", {
              month: "long",
              timeZone,
            }),
            daysInCurrentMonth,
            timeZone,
            localDateTime: now.toLocaleString("de-DE", {
              timeZone,
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          },
        });
      } catch (error) {
        console.error("ADMIN DASHBOARD ERROR:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to load dashboard data",
          error:
            process.env.NODE_ENV === "development"
              ? error.message
              : undefined,
        });
      }
    });

    // =====================================================
    // ROOT
    // =====================================================

    app.get(
      "/",
      (req, res) => {
        res.send(
          "Koly_Store Server is running..."
        );
      }
    );

    // =====================================================
    // START SERVER
    // =====================================================

    app.listen(
      port,
      () => {
        console.log(
          `Koly_Store is running on port ${port}`
        );
      }
    );

  } catch (error) {

    console.error(
      "MongoDB Connection Errors",
      error
    );
  }
}


run();
