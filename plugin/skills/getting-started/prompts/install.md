# Install prompt (send this to new users)

Users paste this into a **Claude Cowork** chat. Replace the part after "I want to find:", or delete that line and Claude will ask.

```
Install Social Listener for me by following https://github.com/ifarhan050/social-listener/blob/main/INSTALL.md
I agree to install it on this computer.
I want to find: complaints and scams about [my brand] in Pakistan.
```

What the user does:
1. Paste the message.
2. Click **accept** on the Social Listener plugin card Claude shows.
3. Only if they want Facebook: log in once in the Facebook window that opens, then close it.

Claude downloads and sets up everything else: Node.js if missing, the app, its packages, the browser, and start at login. Then it creates the mission and runs a first search.

## Update prompt
The same message works for updates. Or:

```
Update Social Listener by following https://github.com/ifarhan050/social-listener/blob/main/INSTALL.md
Keep all my results, settings and Facebook login.
```

## More examples of "I want to find"
- `people asking for a home tutor in Lahore (DHA, Gulberg, Johar Town)`
- `other bakeries and cake shops in Karachi offering home delivery (my competitors)`
- `news and discussions about electric bikes in Pakistan`
