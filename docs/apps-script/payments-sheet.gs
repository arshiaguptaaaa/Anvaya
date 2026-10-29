// Record of the Google Apps Script set-up behind the payments Sheet (as of 2026-10-23). The code lives in Google,
// not here: this file documents it.
//
// Spreadsheet  https://docs.google.com/spreadsheets/d/1iTstXksYD4eOGIAYgnUO9YvzPcdinnvVOMWWkm6hW8I  (tab "Bookings")
//
// 1. Payment page (anvaya-payment.html) → https://script.google.com/macros/s/AKfycbxmOTcxIirra9oulQI3Jo65xr9eJP0AjBZpOeGwyCRH2nkr8FlZ9fkjOD1e__at9Uw/exec
//    An older pinned version of the "ANVAYA RESUME SERVICE" script (project 1zs2MPQxO3QhnMYqUX27JKozR09ZuM8ctFEv7l0OfQRztqsukilN0oP3V).
//    Unchanged. On the browser's success callback it appends a Bookings row (Completed / Sent / Pending), emails
//    the customer (Calendly link) and emails teamanvaya.in@gmail.com ("New booking: …"). On checkout close it
//    appends to "Abandoned Checkouts".
//
// 2. Anvaya app → https://script.google.com/macros/s/AKfycbzUnB3Uudoutq8TSlD8pY2F_9JHIyJvzJ40WfL9RDxnt5hapR1AU3tbPxGuyGgY1qQ/exec
//    Same project, version 6, which adds action "verified_payment" (handleVerifiedPayment). It requires the Script
//    Property PAYMENT_SYNC_TOKEN (= Cloud Run PAYMENT_SHEET_TOKEN), takes a script lock, finds the Bookings row by
//    Payment ID (column B, from row 6) and updates its Payment Status (paid / failed / refunded) or adds the row if
//    the page never reported it. It sends no email.
//
// 3. Razorpay webhook → https://script.google.com/macros/s/AKfycbziy4zo32XHEAa8UjWO8MLeL4D1eKHXxUTlav8xiafRAOGD1EbSrzpqYvmx8MVr/exec
//    The Sheet's own bound script (project 1GULkfXHA9u385lbvXqZkcJOhacYNwf0vOacykHYPQkXI01KqLtuZQ_jH). It reads
//    camelCase fields that Razorpay doesn't send, so every event appends an empty "CAPTURED" row to the "Payments"
//    tab and sends no email. Left as it was.
//
// 4. Checkout enquiries (2026-10-23, version 8 of the app deployment, action "enquiry"): one row per Enquiry ID in
//    the "Abandoned checkouts" tab, updated in place. A–G as before (G = status: Checkout started / Payment failed:
//    reason / Abandoned (no payment after 30 min) / Converted (paid, pay_…)), I = Enquiry ID, J = Follow-up (consent
//    and reminder delivery status), K = Last update. Rows 6–9 (before this) are untouched. The page no longer posts
//    "abandoned" to the old script (that produced one row per close and labelled failures the same way).
