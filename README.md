# ClinicFlow Express Backend

NextJS se convert kiya hua pure Express.js backend — modern authentication ke saath.

## Tech Stack
- **Express.js** + TypeScript
- **Prisma ORM** + PostgreSQL
- **jose** (JWT), **bcryptjs** (password hashing)
- **helmet**, **cors**, **express-rate-limit**

---

## Setup

```bash
# 1. Dependencies install karo
npm install

# 2. .env file banao
cp .env.example .env
# .env mein DATABASE_URL aur secrets fill karo

# 3. Database setup
npm run db:push
npm run db:seed

# 4. Dev server chalao
npm run dev
```

---

## 🔐 Authentication — Kya Kya Features Hain

### Original NextJS se kya improve hua

| Feature | NextJS (Original) | Express (New) |
|---|---|---|
| Token type | Single JWT (7d) | Access (15m) + Refresh (7d) |
| Logout | Cookie sirf clear hoti thi | Token blacklist bhi hota hai |
| Brute force | Koi protection nahi | Account lockout (5 attempts → 15 min lock) |
| Rate limiting | Koi nahi | Auth routes pe strict limiter |
| Password change | Nahi tha | Hai — sari sessions bhi expire hoti hain |
| Logout all sessions | Nahi tha | `/logout-all` endpoint |
| Token rotation | Nahi tha | Refresh token hamesha rotate hota hai |
| Token version | Nahi tha | `tokenVersion` — purane tokens invalid ho jaate hain |
| Password strength | Sirf min 6 chars | Uppercase + number + special char required |
| Security headers | NextJS defaults | Helmet (HSTS, XSS, etc.) |

---

## API Endpoints

### Auth (Public)
```
POST /api/auth/signup          # Register
POST /api/auth/login           # Login
POST /api/auth/logout          # Logout (current session)
POST /api/auth/refresh         # Refresh tokens explicitly
```

### Auth (Protected)
```
GET  /api/auth/me              # Apna profile dekho
POST /api/auth/logout-all      # Sabhi sessions band karo
POST /api/auth/change-password # Password badlo
```

### Protected API
```
GET|POST        /api/appointments
PATCH           /api/appointments/:id

GET|POST        /api/patients
GET|PATCH|DEL   /api/patients/:id

GET|POST        /api/doctors
GET|PATCH|DEL   /api/doctors/:id       [admin only for POST/PATCH/DEL]

GET|POST        /api/departments
PATCH|DEL       /api/departments/:id   [admin only]

GET|POST        /api/billing/invoices
GET|PATCH|DEL   /api/billing/invoices/:id

GET|POST        /api/lab-reports
GET|PATCH       /api/lab-reports/:id

GET|POST        /api/medicines
PATCH|DEL       /api/medicines/:id

GET             /api/notifications
PATCH|DEL       /api/notifications/:id

GET|POST        /api/prescriptions     [POST: doctor only]

GET|POST        /api/medical-records

PATCH           /api/profile
GET             /api/users
GET             /api/dashboard/stats
```

---

## Auth Flow Explanation

### Login
1. Email/password validate hoti hai
2. Account lock check hota hai
3. bcrypt se password compare hota hai
4. **Access token** (15 min) + **Refresh token** (7 days) issue hote hain
5. Dono `httpOnly` cookies mein set hote hain

### Request kaise authenticate hoti hai
1. Access token valid hai → request pass
2. Access token expire → refresh token check hota hai
3. Refresh token valid → **dono tokens rotate** (naya pair issue, purana blacklist)
4. Dono invalid → 401

### Logout
- Refresh token JTI blacklist mein add hota hai
- Dono cookies clear hoti hain

### Logout All Sessions
- `tokenVersion` DB mein increment hota hai
- Purane sab tokens invalid ho jaate hain (access + refresh dono)

### Change Password
- Current password verify hoti hai
- `tokenVersion` increment → sari sessions expire
- Current session ke liye naye tokens issue hote hain

---

## Security Notes

> ⚠️ **Production ke liye:**
> - In-memory blacklist aur lockout store ko **Redis** se replace karo
> - `HTTPS` zaroori hai (cookies `Secure` flag ke saath)
> - `FRONTEND_URL` properly set karo CORS ke liye
> - `ACCESS_TOKEN_SECRET` aur `REFRESH_TOKEN_SECRET` strong random strings honi chahiye (32+ chars)
