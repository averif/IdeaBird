import { useEffect, useRef, useState } from 'react';
import { PLANS } from '../../shared/plans';
import { rememberUpgradeIntent } from '../billing';
import { BrandMark } from '../components/BrandMark';
import { PricingPlans } from '../components/PricingPlans';
import { PixelBird, PixelScreenshot } from './PixelArt';
import './landing.css';

interface LandingProps {
  onLogin: () => void;
  onSignup: () => void;
}

const READS = ['YouTube videos', 'Podcasts', 'Blog posts', 'Articles', 'Newsletters', 'X posts', 'Reddit threads', 'Dashboards', 'Charts', 'Screenshots'];

const STEPS = [
  {
    n: '01',
    title: 'Paste a link',
    body: 'A YouTube video, a podcast, a blog post or an article. Or drop a screenshot of a dashboard, a chart or a tweet.',
  },
  {
    n: '02',
    title: 'IdeaBird finds the story',
    body: 'It reads the whole thing like a strategist, transcript and all: the big ideas, the numbers, the tension, and the angles worth posting about.',
  },
  {
    n: '03',
    title: 'Pick an angle, post',
    body: 'Choose the angle or let IdeaBird choose. Get five ready-to-post drafts, then copy the one that sounds like you.',
  },
];

const FEATURES = [
  { title: 'Reads the whole thing', body: 'Hour-long podcasts, YouTube videos and long articles are read end to end, not just the title. Screenshots are seen, charts and all.' },
  { title: 'Angles, not summaries', body: 'Every link and screenshot comes back with possible stories and angles, so posts say something instead of repeating it.' },
  { title: 'Exact facts', body: 'Metrics, names, dates and quotes are carried over exactly as the source states them. Anything unclear is never stated as fact.' },
  { title: 'Five formats at once', body: 'A hot take, a question, a stat-led post, a thread and a LinkedIn version from a single link or screenshot.' },
  { title: 'Private history', body: 'Every generation is saved to your account. Only you can see it, and you can delete it any time.' },
  { title: 'Built-in guardrails', body: "IdeaBird won't amplify unverified allegations, conspiracy claims or health misinformation." },
];

// Real output from IdeaBird for a revenue dashboard ($12,430 · 1,240 users · +42%).
const FORMATS = [
  { name: 'Hot take', text: "42% MoM growth isn't a strategy. It's a fluke until you can reproduce it without working 80 hours a week." },
  {
    name: 'Question',
    text: 'When you hit +42% growth in one month, how do you tell which customers actually like your product versus which ones just signed up because of a temporary spike?',
  },
  {
    name: 'Stat-lead',
    text: "October: $12,430 revenue, 1,240 users, +42% growth. That's roughly $10 revenue per user. The question isn't whether the number is good. It's whether that $10 scales or shrinks next month.",
  },
  {
    name: 'Thread',
    text: "1. October dashboard: $12,430 revenue, 1,240 users, +42% growth. Looks like a win.\n2. The danger of a 42% month is that you start believing your own hype.\n3. Revenue per user here is about $10. That's the real metric to watch.\n4. Ask what actually drove October. One of these is repeatable. The others are luck.\n5. Don't celebrate the growth. Celebrate the mechanism behind it.",
  },
  {
    name: 'LinkedIn',
    text: 'October looked great on paper: $12,430 in revenue, 1,240 users, and 42% growth.\n\nBut a single strong month can hide a fragile business. The metric that matters is whether you know what caused it.\n\nGrowth without a mechanism is just a lucky streak.',
  },
];

const FAQ = [
  {
    q: 'How is IdeaBird different from ChatGPT?',
    a: "ChatGPT is a blank box: you upload the screenshot, explain the context, write a prompt, ask for each format, then check that the numbers survived. IdeaBird is built for this one job. It reads the screenshot first, pulls out the exact metrics and the stories worth telling, and lets you pick the angle. Then it writes a post that's ready to publish. On Pro you get five at once: a hot take, a question, a stat-led post, a thread and a LinkedIn version, all saved to your history. Numbers are kept exactly as shown, and anything unclear is never stated as fact. No prompting, no copy-pasting, and no posts that sound like everyone else's AI.",
  },
  {
    q: 'Which links work?',
    a: "YouTube videos and podcasts (read from their captions, even hour-long ones), blog posts, articles, newsletters, X posts and Reddit threads. Pages behind a login or paywall can't be read: screenshot the part you care about instead.",
  },
  {
    q: 'What kind of screenshots work best?',
    a: 'Anything with a point to it: analytics dashboards, revenue charts, product launches, tweets, articles, reviews, changelogs. If a person could explain why it matters, IdeaBird can too.',
  },
  {
    q: 'Does it just copy the text from my screenshot?',
    a: "No. A vision model looks at the whole image, works out what it means, and suggests stories and angles. The writer works from that understanding, so posts tell a story instead of rewriting what's on screen.",
  },
  {
    q: 'Are my links and screenshots stored?',
    a: 'No. The page, transcript or image is analyzed and discarded. Only a short summary of what it showed (plus the link itself) and the posts you generated are saved to your private history, and you can delete them.',
  },
  {
    q: 'Which platforms are the posts for?',
    a: 'X (as single posts and a thread) and LinkedIn. Every draft respects the platform\'s length and tone.',
  },
  {
    q: 'What counts as a generation?',
    a: `Each time you turn a link or screenshot into posts. Free includes ${PLANS.free.limits.generationsPerMonth} a month with one post each; Pro includes ${PLANS.pro.limits.generationsPerMonth.toLocaleString('en-US')} a month with all ${PLANS.pro.limits.draftsPerGeneration} variations.`,
  },
];

/** Reveals elements with the `lp-reveal` class as they scroll into view. */
function useReveal() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nodes = rootRef.current?.querySelectorAll('.lp-reveal') ?? [];
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);
  return rootRef;
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export default function Landing({ onLogin, onSignup }: LandingProps) {
  const rootRef = useReveal();
  const [format, setFormat] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="lp" ref={rootRef}>
      <header className={`lp-nav${scrolled ? ' scrolled' : ''}`}>
        <div className="lp-nav-inner">
          <a className="lp-logo" href="#top" aria-label="IdeaBird home">
            <BrandMark size={30} />
            <span>IdeaBird</span>
          </a>
          <nav className="lp-links" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#formats">Formats</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="lp-nav-actions">
            <button className="lp-btn lp-btn-text" type="button" onClick={onLogin}>Log in</button>
            <button className="lp-btn lp-btn-primary lp-btn-sm" type="button" onClick={onSignup}>
              Get started
              <Arrow />
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        {/* --- Hero --- */}
        <section className="lp-hero">
          <div className="lp-hero-art lp-hero-art-left">
            <PixelScreenshot />
          </div>
          <div className="lp-hero-art lp-hero-art-right">
            <PixelBird />
          </div>

          <div className="lp-hero-copy">
            <p className="lp-kicker">
              <span className="lp-dot" aria-hidden="true" /> Link in. Posts out.
            </p>
            <h1>
              Every link
              <br />
              has a story.
            </h1>
            <p className="lp-sub">
              Paste a YouTube video, podcast or article, or drop a screenshot. IdeaBird finds what's worth saying and writes five ready-to-post drafts for X and LinkedIn.
            </p>
            <div className="lp-cta">
              <button className="lp-btn lp-btn-primary" type="button" onClick={onSignup}>
                <span className="lp-btn-square" aria-hidden="true" />
                Start for free
              </button>
              <button className="lp-btn lp-btn-outline" type="button" onClick={onLogin}>
                Log in
              </button>
            </div>
          </div>
        </section>

        {/* --- What it reads --- */}
        <section className="lp-reads" aria-label="What IdeaBird can read">
          <p className="lp-mono">Reads anything you can link or screenshot</p>
          <div className="lp-marquee">
            <div className="lp-marquee-track">
              {[...READS, ...READS].map((item, i) => (
                <span key={i} aria-hidden={i >= READS.length}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* --- Product preview --- */}
        <section className="lp-section" id="how">
          <div className="lp-head lp-reveal">
            <p className="lp-mono">How it works</p>
            <h2>From link to posts in three steps.</h2>
          </div>

          <div className="lp-flow lp-reveal">
            <article className="lp-panel">
              <p className="lp-panel-label">
                <span>01</span> Your screenshot
              </p>
              <div className="lp-mock-shot">
                <p className="lp-mock-title">Dashboard · October</p>
                <div className="lp-mock-metrics">
                  <div>
                    <span>Revenue</span>
                    <strong>$12,430</strong>
                  </div>
                  <div>
                    <span>Users</span>
                    <strong>1,240</strong>
                  </div>
                  <div>
                    <span>Growth</span>
                    <strong className="up">+42%</strong>
                  </div>
                </div>
                <div className="lp-mock-chart" aria-hidden="true">
                  {[28, 34, 30, 42, 48, 45, 58, 64, 72, 88].map((h, i) => (
                    <span key={i} style={{ height: `${h}%` }} />
                  ))}
                </div>
              </div>
            </article>

            <span className="lp-flow-arrow" aria-hidden="true"><Arrow /></span>

            <article className="lp-panel">
              <p className="lp-panel-label">
                <span>02</span> What IdeaBird sees
              </p>
              <p className="lp-mock-summary">A strong month: $12,430 revenue from 1,240 users, up 42%, but no baseline shows what drove it.</p>
              <p className="lp-mock-sub">Angles</p>
              <div className="lp-chips">
                <span className="lp-chip selected">What drove 42% growth</span>
                <span className="lp-chip">$10 revenue per user</span>
                <span className="lp-chip">Lessons from the first $10k</span>
              </div>
            </article>

            <span className="lp-flow-arrow" aria-hidden="true"><Arrow /></span>

            <article className="lp-panel">
              <p className="lp-panel-label">
                <span>03</span> Ready to post
              </p>
              <div className="lp-mock-post">
                <div className="lp-mock-post-head">
                  <span className="lp-avatar" aria-hidden="true" />
                  <div>
                    <strong>You</strong>
                    <span>@you</span>
                  </div>
                </div>
                <p>42% MoM growth isn't a strategy. It's a fluke until you can reproduce it without working 80 hours a week.</p>
              </div>
            </article>
          </div>

          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li key={s.n} className="lp-reveal">
                <span className="lp-step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- Features --- */}
        <section className="lp-section lp-section-surface" id="features">
          <div className="lp-head lp-reveal">
            <p className="lp-mono">Features</p>
            <h2>Built to find the post, not just the text.</h2>
          </div>
          <div className="lp-grid">
            {FEATURES.map((f, i) => (
              <article key={f.title} className="lp-card lp-reveal" style={{ transitionDelay: `${(i % 3) * 70}ms` }}>
                <span className="lp-card-icon" aria-hidden="true">
                  {Array.from({ length: 4 }, (_, k) => (
                    <i key={k} className={(i + k) % 3 === 0 ? 'on' : undefined} />
                  ))}
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* --- Formats --- */}
        <section className="lp-section" id="formats">
          <div className="lp-formats lp-reveal">
            <div className="lp-formats-copy">
              <p className="lp-mono">Five formats</p>
              <h2>One source. Five ways to say it.</h2>
              <p className="lp-body">
                Each draft is written for its platform: punchy single posts for X, a numbered thread, and a LinkedIn version that reads like a person wrote it.
              </p>
              <div className="lp-tabs" role="tablist" aria-label="Post formats">
                {FORMATS.map((f, i) => (
                  <button
                    key={f.name}
                    type="button"
                    role="tab"
                    aria-selected={format === i}
                    className={`lp-tab${format === i ? ' active' : ''}`}
                    onClick={() => setFormat(i)}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="lp-format-card" role="tabpanel" aria-live="polite">
              <div className="lp-format-meta">
                <span className="lp-mono">{FORMATS[format].name}</span>
                <span className="lp-mono">{FORMATS[format].text.length} chars</span>
              </div>
              <p key={format}>{FORMATS[format].text}</p>
              <p className="lp-format-note">Real output for a revenue dashboard screenshot.</p>
            </div>
          </div>
        </section>

        {/* --- Pricing --- */}
        <section className="lp-section" id="pricing">
          <div className="lp-head lp-reveal">
            <p className="lp-mono">Pricing</p>
            <h2>Start free. Go Pro when it clicks.</h2>
            <p className="lp-body">Free gives you one solid post per link or screenshot. Pro gives you every angle, 500 generations a month, and a history of everything you've made.</p>
          </div>
          <PricingPlans
            context="landing"
            showComparison={false}
            onSelect={(plan, interval) => {
              if (plan === 'pro') rememberUpgradeIntent(interval);
              onSignup();
            }}
          />
        </section>

        {/* --- FAQ --- */}
        <section className="lp-section lp-section-narrow" id="faq">
          <div className="lp-head lp-reveal">
            <p className="lp-mono">FAQ</p>
            <h2>Questions, answered.</h2>
          </div>
          <div className="lp-faq">
            {FAQ.map((item) => (
              <details key={item.q} className="lp-reveal">
                <summary>
                  {item.q}
                  <span className="lp-plus" aria-hidden="true" />
                </summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* --- Final CTA --- */}
        <section className="lp-final lp-reveal">
          <p className="lp-final-dots" aria-hidden="true">IDEABIRD</p>
          <h2>Your next post is already in your open tabs.</h2>
          <div className="lp-cta">
            <button className="lp-btn lp-btn-primary lp-btn-on-blue" type="button" onClick={onSignup}>
              <span className="lp-btn-square" aria-hidden="true" />
              Start for free
            </button>
            <button className="lp-btn lp-btn-ghost-on-blue" type="button" onClick={onLogin}>
              Log in
            </button>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <a className="lp-logo" href="#top" aria-label="IdeaBird home">
          <BrandMark size={24} />
          <span>IdeaBird</span>
        </a>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>
          <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a>
        </nav>
        <p className="lp-mono">© {new Date().getFullYear()} IdeaBird</p>
      </footer>
    </div>
  );
}
