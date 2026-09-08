require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

const app = express();

const port = process.env.PORT || 5000;

// =====================================================
// MIDDLEWARE
// =====================================================

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
  ],

  credentials: true,

  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

app.use(express.json());

app.use(cookieParser());

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
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).send({
      success: false,
      message: "Unauthorized access",
    });
  }

  jwt.verify(
    token,
    process.env.ACCESS_TOKEN_SECRET,
    (err, decoded) => {
      if (err) {
        return res.status(401).send({
          success: false,
          message: "Invalid or expired token",
        });
      }

      req.user = decoded;

      next();
    }
  );
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

    const usersCollection =
      db.collection("users");

    const countersCollection =
      db.collection("counters");

    const productsCollection =
      db.collection("products");

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
                "Email already exists",
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

          return res.status(201).send({
            success: true,

            message:
              "Account created successfully",

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
            return res.status(401).send({
              success: false,
              message:
                "Invalid email or password",
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
                "Invalid email or password",
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

      const images = (req.files || []).map(
        (file) => `/uploads/${file.filename}`
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

      const product = {
        productId,
        productNumber,

        productName: cleanProductName,
        description: cleanDescription,
        category: cleanCategory,

        keyFeatures,

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

   app.get("/admin/products", verifyToken, async (req, res) => {
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


app.get("/products", async (req, res) => {
  try {
    const products = await productsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

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

          const product =
            await productsCollection.findOne({
              productId: id,
            });

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

    app.delete("/admin/products/:id", verifyToken, async (req, res) => {
    try {
        // Admin check
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
                message: "Only admin can delete products",
            });
        }

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

        images[0] =
          `/uploads/${file.filename}`;
      }

      // =====================================================
      // IMAGE 2
      // =====================================================

      if (
        req.files?.image2 &&
        req.files.image2.length > 0
      ) {
        const file = req.files.image2[0];

        images[1] =
          `/uploads/${file.filename}`;
      }

      // =====================================================
      // IMAGE 3
      // =====================================================

      if (
        req.files?.image3 &&
        req.files.image3.length > 0
      ) {
        const file = req.files.image3[0];

        images[2] =
          `/uploads/${file.filename}`;
      }

      // =====================================================
      // REMOVE EMPTY IMAGE SLOTS
      // =====================================================

      images = images.filter(Boolean);

      // =====================================================
      // UPDATE DATA
      // =====================================================

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
    // CUSTOMER ONLY
    // =====================================================

    app.get(
      "/customer-only",
      verifyToken,
      (req, res) => {

        if (
          req.user.role !==
          "customer"
        ) {
          return res
            .status(403)
            .send({
              success: false,
              message:
                "Forbidden access",
            });
        }

        res.send({
          success: true,
          message:
            "Welcome Customer",
        });
      }
    );

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
      "MongoDB Connection Error:",
      error
    );
  }
}

// =====================================================
// RUN SERVER
// =====================================================

run();
