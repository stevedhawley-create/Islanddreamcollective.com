# islanddreamco.com — Site Setup

## Files Included
- `index.html` — Home page
- `list-your-villa.html` — Owner lead generation page
- `style.css` — Shared styles
- `README.md` — This file

## Before Going Live

### 1. Formspree (Enquiry Form)
The list-your-villa form currently has `FORMSPREE_ID` as a placeholder.
- Go to formspree.io and create a **new form** for IDC (keeps leads separate from balivillabookings.com)
- Copy your new form ID (e.g. `xrgpjkbl`)
- In `list-your-villa.html`, find this line:
  `<form action="https://formspree.io/f/FORMSPREE_ID"`
  and replace `FORMSPREE_ID` with your new ID

### 2. Email Address
The footer and contact references use `hello@islanddreamco.com`.
Make sure this email address is set up in GoDaddy and forwarding correctly before the site goes live.

### 3. Logo
Currently using the logo hosted on balivillabookings.com:
`https://www.balivillabookings.com/logo.png`
Works fine initially. Long-term, add a copy of the logo to this repo.

### 4. Villa Photos
Images are pulled from the Lodgify CDN — these are the same images used on balivillabookings.com.
If they ever stop working, download and host copies in this repo.

## GitHub + Vercel Setup
1. Create a new GitHub repo: `islanddreamco-site`
2. Push these files to main
3. In Vercel, click "Add New Project" → import from GitHub
4. No build settings needed (plain HTML)
5. In Vercel project settings → Domains → add `islanddreamco.com`
6. In GoDaddy DNS, set CNAME record:
   - Name: `www`
   - Value: `cname.vercel-dns.com`
   - Also add the A record Vercel gives you for the apex domain

## Pages Still to Build
- `services.html` — Full services breakdown
- `portfolio.html` — Portfolio detail page
- `about.html` — Steve & Tara full story
- `blog.html` + 5 SEO blog posts targeting owner keywords
- `contact.html` — Contact page
- `faq.html` — Full FAQ

## Redirect: balivillabookings.com/list-your-villa
Once this site is live, add a 301 redirect in balivillabookings.com:

In the `<head>` of the old list-your-villa.html on balivillabookings.com, add:
```html
<meta http-equiv="refresh" content="0; url=https://www.islanddreamco.com/list-your-villa.html" />
```
Or handle via Vercel redirects config in vercel.json.
