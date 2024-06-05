import express from "express"
import pg from "pg"
import bodyParser from "body-parser"
import env from "dotenv"
import bcrypt from "bcrypt"
import passport from "passport"

const app = express();
const port = process.env.PORT || 4000;
const saltRounds = 10;

env.config()

// app.use(
//     session({
//         secret: process.env.SESSION_SECRET,
//         resave: false,
//         saveUninitialized: true,
//       })
// )

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(bodyParser.text())
app.use(express.static("public"))  

app.use(passport.initialize())
// app.use(passport.session())

const db = new pg.Client({
    user: process.env.PG_USER,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    ssl: {
        rejectUnauthorized: true, 
    },
})  

db.connect()

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://learn2024.netlify.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
   });







//COURSES FORMAT
var courses = [
    {
        id: 1, 
        courseName: "ENGLISH",
        courseCode: 101,
        uniqueCode: "ENG 101" ,
        courseContent:[
            "Intro to English", 
            "Nouns" , 
            "Pronouns", 
            "Verbs", 
            "Intejection", 
            "Conjuction"
        ]
    },
    {
        id: 2, 
        courseName: "ENGLISH",
        courseCode: 102, 
        uniqueCode: "ENG 102" ,
        courseContent:[
            "Sentences", 
            "Words" , 
            "Comprehension", 
            "Insight of english", 
            "Damn", 
            "Conjuction"
        ]
    },
    {
        id: 3, 
        courseName: "Mathematics",
        courseCode: 101, 
        uniqueCode: "MAT 101" ,
        courseContent:[
            "Intro to Maths", 
            "History on Mathematics" , 
            "Basic Arithmetic", 
            "Abacus", 
            "Complex Arithmetic", 
            "Equations"
        ]
    },
    {
        id: 4, 
        courseName: "Mathematics",
        courseCode: 102,
        uniqueCode: "MAT 102" , 
        courseContent:[
            "Equations II", 
            "Arithmetic II" , 
            "Basic Arithmetic", 
            "Abacus", 
            "Complex Arithmetic", 
            "Equations"
        ]
    },
]
var courseExplain = [
    {
        id: 1,
        courseTopic: "Intro to English",
        courseVideo: "link", 
        courseContent: "English is a language which originated from ............."
    },
    {
        id: 2,
        courseTopic: "Nouns",
        courseVideo: "link", 
        courseContent: "English is a language which originated from ............."
    },
    {
        id: 3,
        courseTopic: "Pronouns",
        courseVideo: "link", 
        courseContent: "English is a language which originated from ............."
    },
    {
        id: 4,
        courseTopic: "Verbs",
        courseVideo: "link", 
        courseContent: "English is a language which originated from ............."
    },
    {
        id: 5,
        courseTopic: "Intro to Maths",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    },
    {
        id: 6,
        courseTopic: "Basic Arithmetic",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    },
    {
        id: 7,
        courseTopic: "Abacus",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    },
    {
        id: 8,
        courseTopic: "Equations II",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    },
    {
        id: 9,
        courseTopic: "Arithmetic II",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    },
    {
        id: 10,
        courseTopic: "Equations",
        courseVideo: "link", 
        courseContent: "Mathematics is a way of ............."
    }
]

app.get("/courses/:uniquecode", (req, res) => {
    const uniqueCode = String(req.params.uniquecode)
    const getCourses = courses.find((course) => course.uniqueCode === uniqueCode)
    res.json(getCourses)
})

app.get("/coursetopic", (req, res) => {
    const topic = req.query.topic
    const getTopic = courseExplain.filter((course) => course.courseTopic === topic)
    res.json(getTopic)
})

//THE END

//SAVE COURSES
//get id of current user
app.post("/id", async (req, res) => {  
    const emails = req.body.email
    const course = req.body.course
    const code = req.body.courseCode
try {
    const result = await db.query("SELECT id FROM student_profile  WHERE email = $1", [emails])
    const getID = result.rows[0].id
    const saveCourse = await db.query("INSERT INTO course_chosen (course, course_code, student_id) VALUES ($1, $2, $3)", [course, code,  getID])
    res.status(200).json({ success: "Course Registered successfully", id: getID })
} catch (error) { 
    console.log(error)
}
 })


 //get Registered courses 
app.post("/courses-registered", async(req, res) => {
    const emails = req.body.email
    try {
        const result = await db.query("SELECT id FROM student_profile  WHERE email = $1", [emails])
        const getID = result.rows[0].id
        const results = await db.query("SELECT *  FROM course_chosen WHERE student_id  = $1", [getID])
        // console.log(results.rows)
        const courses = results.rows
        res.status(200).json(courses)
    } catch (error) {
      console.log(error)  
    }
 })




//SIGN AND LOGIN FORMAT 
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
    const email = req.body.email
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