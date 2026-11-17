# IdeaBird 

**Turn anything you find online into content worth sharing.**

IdeaBird is an AI-powered content repurposing platform that transforms existing content into engaging, platform-ready social media posts. Simply paste a YouTube video, tweet, blog article, or other supported social media link, and IdeaBird turns it into ready-to-publish X (Twitter) and LinkedIn content.

You can also turn screenshots into social media posts or refine your existing drafts to make them clearer, sharper, and more engaging.

##  Features

### 🔗 Link to Social Posts
Turn content from across the internet into social media posts.

- **YouTube videos:** Convert video content into engaging tweets and LinkedIn posts.
- **X (Twitter) posts:** Repurpose existing tweets into fresh content.
- **Blog articles:** Extract key insights and transform articles into social posts.
- **Other supported links:** Repurpose content from supported online sources.
- Generate platform-specific content for X and LinkedIn.

###  Screenshot to Posts
Turn screenshots into content ideas and ready-to-publish posts.

- Upload screenshots containing text, statistics, charts, dashboards, or other information.
- AI analyzes the visual context and identifies interesting content angles.
- Generate multiple content formats, including hot takes, questions, statistics-led posts, threads, and LinkedIn posts.
- Choose a content angle or let AI select one.

###  Post Refinement
Improve your existing tweets and LinkedIn drafts.

- Rewrite posts for better clarity and readability.
- Improve hooks and opening lines.
- Make content more engaging and natural.
- Refine tone, structure, and wording.
- Turn rough ideas into polished, publish-ready posts.

###  Authentication & History
- Email and password authentication.
- Google sign-in.
- Email verification and password reset.
- Private generation history.
- Secure, user-specific content storage.

##  How It Works

1. **Find content:** Copy a YouTube video, tweet, blog article, or another supported URL.
2. **Paste the link:** Add it to IdeaBird.
3. **Generate:** AI analyzes the source and extracts its key ideas, insights, and interesting angles.
4. **Choose your platform:** Generate content for X (Twitter) or LinkedIn.
5. **Refine and publish:** Edit your results or use the refinement feature to improve your drafts.

You can also upload a screenshot or paste an existing draft to use the other IdeaBird tools.

##  Tech Stack

| Category | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Express, TypeScript |
| AI | NVIDIA NIM |
| Database | PostgreSQL / PGlite |
| Authentication | JWT, Google OAuth |
| Validation | Zod |
| Security | Helmet, rate limiting |
| Image Processing | Tesseract.js (OCR fallback) |

##  Getting Started

### Prerequisites

- Node.js
- npm
- NVIDIA NIM API key
- PostgreSQL database (optional for local development)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/averif/IdeaBird.git
   cd IdeaBird
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file in the project root:

   ```env
   NVIDIA_API_KEY=your_nvidia_api_key
   NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1

   NVIDIA_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
   NVIDIA_VISION_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b

   DATABASE_URL=pglite:./.data/ideabird
   JWT_SECRET=your_secure_random_secret
   APP_URL=http://localhost:5173

   GOOGLE_CLIENT_ID=
   RESEND_API_KEY=
   PORT=3001
   ```

   See `.env.example` for the complete environment configuration.

4. Start the development servers:

   ```bash
   npm run dev
   ```

5. Open the application:

   ```text
   http://localhost:5173
   ```

## 🧪 Testing

Run the test suite:

```bash
npm test
```

Run the production build:

```bash
npm run build
```

##  Security

IdeaBird includes several security measures:

- Password hashing using Node.js scrypt.
- Short-lived JWT access tokens.
- Rotating refresh tokens.
- Email verification.
- CSRF protection.
- Rate limiting.
- Input validation using Zod.
- User-specific generation history and data isolation.

##  Roadmap

- [ ] Support more content sources and platforms.
- [ ] Improve content extraction and generation quality.
- [ ] More advanced writing and refinement controls.
- [ ] Custom writing styles and tone preferences.
- [ ] Content templates for different audiences.
- [ ] More platform-specific content formats.

##  Contributing

Contributions, suggestions, and bug reports are welcome.

Feel free to open an issue or submit a pull request.

##  License

See the repository for licensing information.

---

**IdeaBird — Find ideas. Repurpose content. Create better posts.** 
