# Agent Fox - Personal Finance Assistant

AI-powered expense tracking system with conversational interface.

## 🚀 Quick Start

### Prerequisites
- Docker (for PostgreSQL & LocalStack S3)
- Node.js 18+
- npm

### Start Services
```bash
# Start Docker containers
docker-compose up -d

# Terminal 1 - Backend
cd apps/api
npm install
npm run start:dev

# Terminal 2 - Frontend
cd apps/web
npm install
npm run dev
```

### Access
- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3009

---

## 📚 Documentation

All generated documentation is in:
- **`docs/`** - Session-specific guides and reports
- **`Knowledge/`** - Technical analysis and findings

### Key Files:
- `docs/SERVERS_READY.md` - Current testing status
- `docs/FIXES_COMPLETE.md` - Latest fixes applied
- `Knowledge/WORKBOOK_ANALYSIS_FINDINGS.md` - Excel structure analysis
- `Knowledge/PHASES_1-4_COMPLETION_CHECKLIST.md` - Implementation progress

---

## 🧪 Testing

See `docs/SERVERS_READY.md` for current test instructions.

---

## 🏗️ Architecture

- **Backend:** NestJS + LangGraph + Azure OpenAI
- **Frontend:** React + TypeScript + Vite
- **Storage:** LocalStack S3 (dev) + PostgreSQL
- **AI:** GPT-5-mini for conversational workflows

---

## 📝 Current Status

Phase 5 (React Frontend Integration) implementation complete.
See `docs/SERVERS_READY.md` for testing instructions.

---

**Note:** Generated documentation files are gitignored but preserved locally for reference.
