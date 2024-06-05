SELECT student_profile.id, user_name, email, course, course_code
FROM student_profile
JOIN course_chosen
ON student_profile.id = course_chosen.id


SELECT student_profile.id FROM student_profile 
WHERE student_profile.email = 'victoriadoe@gmail.com'