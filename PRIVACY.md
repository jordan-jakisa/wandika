# Wandika privacy policy

Last updated 4 November 2026.

Wandika is a free notes app for Mac, iPhone and Android, made by Jordan Mungujakisa. It has no
server and no accounts of its own. Everything it reads stays on your device, apart from your notes,
which go to the GitHub repository you choose.

## What Wandika reads, and why

| Source | What Wandika does with it |
|---|---|
| Your notes | Keeps them as Markdown files on your device. If you connect GitHub, it syncs them with the repository you pick. |
| GitHub (`repo` scope) | Lists your repositories so you can pick one, creates one if you ask, and syncs the one you picked. |
| Google Calendar (`calendar.readonly`) | Shows today's events. Adds them to a note when you ask. |
| Google Tasks (`tasks`) | Shows your tasks, and marks one done when you tick it. |
| Gmail (`gmail.readonly`) | Only in the developer's own build. The versions you can download don't ask for Gmail. |
| Outlook mail and calendar | Shows recent mail and today's events, read only. Saves an email as a note when you ask. |
| Apple Calendar and Reminders | Read on the device, with your permission. Reminders are marked done when you tick them. |
| Microphone and speech recognition | Only while you make a voice note, with your permission. Your words are turned into text on your device, and only the text is kept, in your note. The audio is never saved or sent anywhere: Wandika only uses speech recognition that works offline. |

## Who receives your data

- **GitHub** receives your notes, in your own repository, when you connect it.
- **Google** and **Microsoft** receive only the requests needed to show your calendar, tasks and
  mail, under your own account.
- **Apple** receives nothing from Wandika: Apple Calendar and Reminders are read on your device,
  and voice notes are turned into text on your device.
- **Claude Code** (Mac only, if you set it up): Wandika on the Mac can let Claude Code on the same
  Mac read and change your notes and tasks. Encrypted notes stay locked, and mail and calendars are
  not offered. What Claude Code does with what it reads is covered by Anthropic's terms.

Nobody else receives anything. Your data is never sold or used for advertising.

## What Wandika does not do

- No accounts, no analytics, no ads and no tracking.
- No server: Wandika talks directly from your device to GitHub, Google, Microsoft and Apple.
- Google user data is not used to train AI models and is not transferred to anyone else.

## Where your sign-ins are kept, and how to remove them

Sign-in tokens stay on your device: in the Keychain on Mac and iPhone, and in Wandika's private app
storage on Android, which other apps can't read. They stay until you remove them.

- **In Wandika:** Settings, then Connections, then Disconnect (or Sign out for GitHub). This deletes
  the stored token.
- **Google:** https://myaccount.google.com/permissions
- **Microsoft:** https://account.live.com/consent/Manage (personal accounts) or
  https://myapps.microsoft.com (work or school accounts).
- **GitHub:** https://github.com/settings/applications

Deleting the app also deletes its stored tokens. Your notes stay where you keep them: in the folder
on your device and in your GitHub repository, which you control.

## Google API Services

Wandika's use and transfer of information received from Google APIs will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Children

Wandika is not directed at children under 13.

## Changes

If this policy changes, the new version is published here with a new date.

## Contact

jordan.timutic@gmail.com
