# Portal emails

Two jobs, and only one of them is a file in this folder.

## 1. Who the email comes from — custom SMTP

Supabase's built-in mailer always signs itself **Supabase Auth**, and it is rate
limited to a handful of messages an hour. Changing the sender means pointing
Supabase at an SMTP provider on a domain Brace owns.

**Pick a provider** — [Resend](https://resend.com) is the least friction
(3,000 emails/month free, DNS records generated for you). Postmark, SendGrid
and AWS SES all work the same way.

**Verify the domain.** The provider gives three DNS records to add wherever
the domain is managed:

| Record | Why it matters |
|---|---|
| SPF (TXT) | says this provider may send as your domain |
| DKIM (TXT/CNAME) | signs each message so it cannot be forged |
| DMARC (TXT) | tells inboxes what to do with mail that fails the other two |

Without all three, mail from a new domain lands in spam. Verification is
usually minutes, occasionally an hour.

**One SPF record, no more.** A domain may carry exactly one `v=spf1` TXT
record; two makes both fail, and the mail with them. If GoDaddy's email
already added `v=spf1 include:secureserver.net -all`, do not add a second —
merge the new sender into the existing one:

    v=spf1 include:secureserver.net include:_spf.resend.com ~all

DKIM and DMARC are per-provider and stack happily; only SPF is jealous.

**A mailbox and a sender are different things.** GoDaddy's Professional Email
gives humans somewhere to read and write — `eddie@braceshooting.com`. The
portal's emails need no mailbox at all: a provider signs and sends as
`portal@braceshooting.com` whether or not anything could receive there. Both
can live on one domain; only the SPF record has to be shared.

**Point Supabase at it:** Dashboard → Project Settings → Authentication →
**SMTP Settings** → enable custom SMTP and fill in:

- Host / port / username / password — from the provider
- **Sender email**: `portal@braceshooting.com` — it needs no mailbox behind it;
  a transactional sender only has to be on a domain the provider has verified
- **Sender name**: `Brace`

Send yourself a reset from the portal to confirm. It should arrive from
**Brace**, not Supabase Auth.

## 2. What the email looks like — the templates here

Supabase → Authentication → **Emails**. Each template is a body plus a
subject; paste the file, set the subject.

| File | Template | Subject |
|---|---|---|
| `reset-password.html` | Reset Password | Reset your Brace password |
| `invite.html` | Invite user *and* Confirm signup | You have been added to the Brace owners portal |

`{{ .ConfirmationURL }}` is Supabase's placeholder for the link — leave it
exactly as written. Other variables available: `{{ .Email }}`, `{{ .Token }}`
(the six-digit code, if you ever want code-in-email instead of a link),
`{{ .SiteURL }}`.

Why the markup looks dated: email clients strip stylesheets and ignore most
of CSS, so these are tables with inline styles, and the wordmark is
letter-spaced text rather than the brand SVG — no mail client renders SVG.

## 3. Redirect allowlist

Supabase refuses to send a link pointing anywhere it does not recognise.
Dashboard → Authentication → URL Configuration:

- **Site URL**: `https://brace-cyan.vercel.app` (become `https://braceshooting.com`
  once the domain fronts the site)
- **Redirect URLs**: `https://brace-cyan.vercel.app/portal/**` and
  `https://braceshooting.com/portal/**` — list both through the changeover.

A reset email that never arrives is nearly always this list, not the mailer.
