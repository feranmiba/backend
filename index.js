import express from "express"
import pg from "pg"
import bodyParser from "body-parser"
import env from "dotenv"
import bcrypt from "bcrypt"
import passport from "passport"
import session from "express-session"

const app = express();
const port = process.env.PORT || 3000;
const saltRounds = 10;

env.config()

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
      })
)

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(express.static("public"))

app.use(passport.initialize())
app.use(passport.session())

const db = new pg.Client({
    user: process.env.PG_USER,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT
})

db.connect()

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3001');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
  });

app.get("/", function (req, res) {
    res.sendFile(
        pth.join(__dirname, "../client/build/index.html"),
        function(err) {
            if (err) {
                res.status(500).send(err)
            }
        }
    )
})


app.post("/signup", async (req, res) => {
    const email = req.body.email
    const username = req.body.username
    const password= req.body.password


    try {
        const checkIfUseExist = await db.query("SELECT * FROM student_profile WHERE email = $1", [email])
        if (checkIfUseExist.rows.length > 0) {
            res.status(400).json({ error: "User email already exists"})
        } else {
            bcrypt.hash(password, saltRounds, async(err, hash) => {
                if (err) {
                    console.log(`error hashing password`)
                    res.status(500).json({error: "Internal server error, please try again."})
                } else {
                  await db.query("INSERT INTO student_profile (user_name, email, password) VALUES ($1, $2, $3)", 
                [username, email, hash] )
                res.status(200).json({success: "Account created successfully"})
                }
            })
        }

    } catch(error) {
        console.log(error)
    }
})
app.post("/google/signup", async (req, res) => {
    const username = req.body.name
    const email = req.body.email


    try {
        const checkIfUseExist = await db.query("SELECT * FROM student_profile WHERE email = $1", [email])
        if (checkIfUseExist.rows.length > 0) {
            res.status(400).json({ error: "User email already exists"})
        } else {
                  await db.query("INSERT INTO student_profile (user_name, email, password) VALUES ($1, $2, $3)", 
                [username, email, "google"] )
                res.status(200).json({success: "Account created successfully"}) 
        }

    } catch(error) {
        console.log(error)
    }
})


app.post("/login", async (req, res) => {
    const email = req.body.email
    const password = req.body.password

    try {
        const checkIfExist = await db.query("SELECT * FROM student_profile WHERE email = $1", [email])
        if (checkIfExist.rows.length > 0) {
            const user = checkIfExist.rows[0]
            const userPassowrd = user.password
            bcrypt.compare(password, userPassowrd,(err, result) => {
                if (err) {
                   res.status(500).json({error: "Internal error, Please try again"}) 
                } else {
                if (result) {
                   res.status(200).json({name: user.user_name}) 
                } else {
                  res.status(400).json({error: "Incorrect password. Try again"})  
                }
                }
            })
        } else {
          res.status(400).json({error: "User not found"})
        }

    } catch(error) {
        console.log(error)
    }
})
app.post("/google/login", async (req, res) => {
    console.log(req.body)
    const email = req.body.email
    console.log(email)
    try {
        const checkIfExist = await db.query("SELECT * FROM student_profile WHERE email = $1", [email])
        if (checkIfExist.rows.length > 0) {
            const user = checkIfExist.rows[0]
            res.status(200).json({success: "Login successful"}) 
        } else {
          res.status(400).json({error: "User not found"})
        }

    } catch(error) {
        console.log(error)
    }
})

app.post("/profiles", async(req, res) => {

})

passport.serializeUser((user, cb) => {
    cb(null, user);
});


passport.deserializeUser((user, cb) => {
    cb(null, user);
});


app.listen(port, () => {
    console.log(`listening on port ${port}`)
})