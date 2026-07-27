# Scanning

Scanning is read-only. The content script selects an ATS adapter, examines accessible DOM controls,
normalizes labels and canonical keys, extracts job context, and stores the result in extension
local storage. It does not change values.

Generic HTML, Greenhouse, Lever, and Workday have tested implementations. Ashby, iCIMS,
SmartRecruiters, SuccessFactors, and Taleo are detected but use the generic scanner with a warning.
Cross-origin frames remain manual.
