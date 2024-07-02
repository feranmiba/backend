import express from "express"
import pg from "pg"
import bodyParser from "body-parser"
import env from "dotenv"
import bcrypt from "bcrypt"
import passport from "passport"

const app = express();
const port = process.env.PORT || 3000;
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
            "Basic Arithmetic", 
            "Time", 
            "Money",
            "Complex Arithmetic"    
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
        courseVideo: "https://www.youtube.com/embed/CbPy_CjJR90?si=aoUXUBE5sa-fklYd", 
        courseContent: "English language, West Germanic language of the Indo-European language family that is closely related to the Frisian, German, and Dutch (in Belgium called Flemish) languages. English originated in England and is the dominant language of the United States, the United Kingdom, Canada, Australia, Ireland, New Zealand, and various island nations in the Caribbean Sea and the Pacific Ocean.English is the most spoken language in the world, primarily due to the global influences of the former British Empire. the have a lot of grammars classification which are :",
        types: [
            'Nouns and noun phrases',
            'Adjectives', 
            'Determiners',
            'Pronouns, case, and person',
            'Prepositions',
            'Verbs and verb phrases',
            'Tense, aspect and mood',
            'Adverbs'
        ]
    },
    {
        id: 2,
        courseTopic: "Nouns",
        courseVideo: "https://www.youtube.com/embed/tquecIG-Pws?si=eaVIlymoGv9o67RZ", 
        courseContent: "A noun is a word that names something, such as a person, place, thing, or idea. In a sentence, nouns can play the role of subject, direct object, indirect object, subject complement, object complement, appositive, or modifier.",
        types: [
            ' common nouns',
            'Countable nouns', 
            'Uncountable nouns',
            ' Possessive nouns',
        ]
    },
    {
        id: 3,
        courseTopic: "Pronouns",
        courseVideo: "https://www.youtube.com/embed/c4300UidkFg?si=JNNoGr0tNPnodPti", 
        courseContent: 'Pronouns are words we use instead of repeating nouns. They help us talk about people, things, or ideas without always saying their names. For example, instead of saying "John went to the store," you can say "He went to the store." This makes sentences shorter and easier to understand. There are different types of pronouns:',
        types: [
            'Personal Pronouns',
            'Demonstrative Pronouns:', 
            'Relative Pronouns',
            'Reflexive and Intensive Pronouns',
        ]
    },
    {
        id: 4,
        courseTopic: "Verbs",
        courseVideo: "https://www.youtube.com/embed/DzmmSbLwOGo?si=7JcDPqtzguKQBZ7n", 
        courseContent: 'Verbs are words that tell us what someone or something is doing or feeling. They show actions like "run," "eat," or "play," or describe states like "is," "seems," or "becomes." Verbs can also help us understand when something happened (past, present, future) and whether the action is being done to someone or by someone. They"re crucial for making sentences make sense and for expressing ideas clearly in both talking and writing.',
        types: [
            'Action Verbs',
            'Linking Verbs', 
            'Auxiliary Verbs',
            'Tense',
        ]
    },
    {
        id: 5,
        courseTopic: "Intro to Maths",
        courseVideo: "https://www.youtube.com/embed/aaJo07SrSWQ?si=U9LLmjxILuO14-uK", 
        courseContent: "Introduction to mathematics is about understanding basic concepts that form the foundation of math. It begins with numbers (like 1, 2, 3...) and how we use them for counting and measuring things.Math also includes operations like adding, subtracting, multiplying, and dividing, which help us solve problems. Shapes, patterns, and measurements (like length or weight) are also part of math. Learning math helps us solve everyday problems, understand the world better, and even discover new things. It's like a language that helps us describe and make sense of the world around us."
    },
    {
        id: 6,
        courseTopic: "Basic Arithmetic",
        courseVideo: "https://www.youtube.com/embed/IwW0GJWKH98?si=sFvcKeEkXr_bB6gW", 
        courseContent: "Basic arithmetic is the fundamental part of mathematics that deals with simple operations involving numbers. It includes four main operations:",
        types: [
            'ADDITION: Combining two or more numbers to find a total. For example, 2+3=5.',
            'SUBTRACTION: Finding the difference between two numbers. For example, 5−2=3.', 
            'MULTIPLICATION: Repeated addition of the same number. For example, 2×3=6 means adding 2 three times.',
            'DIVISION: Splitting a number into equal parts or finding out how many times one number fits into another. For example, 6÷2=3 means dividing 6 into 2 equal groups gives 3 in each group.',
        ]
    },
    {
        id: 7,
        courseTopic: "Time",
        courseVideo: "https://www.youtube.com/embed/QU-XUmujbuM?si=D5BX3HS3TU7lqCpO", 
        courseContent: "Time is how we measure moments and the order in which things happen. It helps us know when things occur, like when to wake up, eat, or go to bed. We use clocks and calendars to keep track of time, whether it's seconds, hours, days, or years. Time is important for planning our days and understanding the past, present, and future.",
        types: [
            '60 seconds make 1 minute',
            '60 minute adds up to 1 hour', 
            '24 hours makes up a day',
            '7 days makes up 1 week',
        ]
    },
    {
        id: 8,
        courseTopic: "Equations II",
        courseVideo: "", 
        courseContent: "Coming soon"
    },
    {
        id: 9,
        courseTopic: "Arithmetic II",
        courseVideo: "", 
        courseContent: "Coming soon"
    },
    {
        id: 10,
        courseTopic: "Equations",
        courseVideo: "", 
        courseContent: "Coming soon"
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