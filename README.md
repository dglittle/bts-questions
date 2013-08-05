bts-questions
=============

bayesian truth serum style questions

commands to set it up on heroku:

```
heroku apps:create bts-questions
heroku addons:add mongohq:sandbox

heroku config:set HOST=http://bts-questions.herokuapp.com
heroku config:set SESSION_SECRET=change_me

git push heroku master
```
