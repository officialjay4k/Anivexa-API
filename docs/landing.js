// ============================================================
// Cloud Hub — landing.js
// Background hero + search redirect + suggestion chips.
// ============================================================

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

const SUGGESTIONS = [
  'One Piece',
  'Solo Leveling',
  'Jujutsu Kaisen',
  'Oshi No Ko',
  'Mashle',
];

// ---------- Background hero ----------
async function loadHero() {
  const bg = document.getElementById('landingBg');
  if (!bg) return;

  bg.style.backgroundImage = "url('/hero.png')";

  // Fallback: if hero.png isn't there yet, tile some trending covers.
  const probe = new Image();
  probe.onerror = async () => {
    bg.style.backgroundImage = '';
    await loadFallbackCollage(bg);
  };
  probe.src = '/hero.png';
}

async function loadFallbackCollage(bg) {
  const query = `
    query {
      Page(page: 1, perPage: 24) {
        media(type: ANIME, sort: TRENDING_DESC) {
          coverImage { extraLarge large }
        }
      }
    }
  `;
  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    const covers = (json?.data?.Page?.media || [])
      .map(m => m.coverImage?.extraLarge || m.coverImage?.large)
      .filter(Boolean);
    if (!covers.length) return;
    bg.style.display = 'grid';
    bg.style.gridTemplateColumns = 'repeat(6, 1fr)';
    bg.style.gridTemplateRows = 'repeat(4, 1fr)';
    bg.style.filter = 'blur(48px) saturate(0.75) brightness(0.55)';
    bg.style.opacity = '0.55';
    const shuffled = covers.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < 24; i++) {
      const url = shuffled[i % shuffled.length];
      if (!url) continue;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      bg.appendChild(img);
    }
  } catch {}
}

// ---------- Search ----------
function goToSearch(query) {
  const q = (query || '').trim();
  if (!q) return;
  window.location.href = `/home?q=${encodeURIComponent(q)}`;
}

function initSearch() {
  const form = document.getElementById('landingSearch');
  const input = document.getElementById('landingSearchInput');
  if (!form || !input) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    goToSearch(input.value);
  });
}

// ---------- Suggestion chips ----------
function initSuggestions() {
  const wrap = document.getElementById('landingSuggestions');
  if (!wrap) return;

  for (const s of SUGGESTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'landing-chip';
    btn.textContent = s;
    btn.addEventListener('click', () => {
      const input = document.getElementById('landingSearchInput');
      if (input) input.value = s;
      goToSearch(s);
    });
    wrap.appendChild(btn);
  }
}

// ---------- Boot ----------
loadHero();
initSearch();
initSuggestions();
