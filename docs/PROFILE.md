# Profile

The shared Zod profile schema is the only contract used by the extension and server. The server
stores the validated profile durably in SQLite. Blank values remain unknown; the matcher never
guesses. Sensitive categories carry explicit policies and default to review.

Profile editing is available in Settings and includes identity/contact, links, education,
experience, projects, activities, volunteering, skills, credentials, eligibility, preferences,
and sensitive-answer policy. Save operations validate locally and on the server.
