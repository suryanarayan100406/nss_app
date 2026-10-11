/* Progressive CMS bridge.
   The original HTML remains the first render and fallback. When the API is
   available this layer replaces only database-backed values, preserving the
   supplied visual structure and GSAP/Lenis runtime. */
(function () {
  'use strict';
  var apiRoot = window.NSS_API_ROOT || (location.hostname === 'localhost' && location.port !== '4000' ? 'http://localhost:4000/api/v1' : '/api/v1');
  function get(path) { return fetch(apiRoot + path, { credentials: 'include' }).then(function (r) { if (!r.ok) throw new Error('CMS request failed'); return r.json(); }); }
  function text(selector, value, root) { var el = (root || document).querySelector(selector); if (el && value != null) el.textContent = value; }
  function attr(selector, name, value, root) { var el = (root || document).querySelector(selector); if (el && value) el.setAttribute(name, value); }
  function formatDate(value) { return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function mapLegacySlug() {
    var file = (location.pathname.split('/').pop() || '').toLowerCase();
    return { 'event-walkathon.html': 'walkathon-26', 'event-plantation-drive.html': 'campus-wide-greenery-plantation-drive', 'event-blood-donation.html': 'blood-donation-camp-2025', 'event-cleanliness-drive.html': 'cleanliness-drive-2025', 'event-nukkad-natak.html': 'nukkad-natak-hiv-aids-awareness', 'event-sports-cricket.html': 'national-sports-day-cricket-2026', 'event-sports-football.html': 'national-sports-day-football-2026' }[file];
  }
  function renderEvents(events) {
    var rail = document.getElementById('eventsRail');
    if (!rail || !events || !events.length) return;
    var cards = Array.prototype.slice.call(rail.querySelectorAll('.event-card'));
    var template = cards[0];
    events.forEach(function (event, i) {
      var card = cards[i];
      if (!card && template) { card = template.cloneNode(true); card.classList.remove('feature', 'ig'); rail.appendChild(card); }
      if (!card) return;
      card.setAttribute('data-event-id', event.id);
      card.setAttribute('data-event-url', 'event.html?slug=' + encodeURIComponent(event.slug));
      var link = card.querySelector('h3 a'); if (link) { link.textContent = event.title; link.href = 'event.html?slug=' + encodeURIComponent(event.slug); }
      var date = card.querySelector('.event-date'); if (date) date.textContent = formatDate(event.startAt) + ' · ' + event.category;
      var copy = card.querySelector('.body > p:last-of-type'); if (copy && event.summary) copy.textContent = event.summary;
      if (event.cover && event.cover.url) { var image = card.querySelector('.media img'); if (image) { image.src = event.cover.url; image.alt = event.cover.altText || event.title; } }
      var hit = card.querySelector('.media-hit'); if (hit && hit.tagName === 'A') hit.href = 'event.html?slug=' + encodeURIComponent(event.slug);
    });
    if (window.ScrollTrigger && window.ScrollTrigger.refresh) window.ScrollTrigger.refresh();
  }
  function hydrateHome(data) {
    if (!data) return;
    var content = data.content || {};
    if (content.hero) { text('#heroMotto', content.hero.motto); text('#heroSub', content.hero.body); }
    (data.metrics || []).forEach(function (metric, i) { var item = document.querySelectorAll('.impact-item')[i]; if (!item) return; var number = item.querySelector('[data-count]'); if (number) { number.setAttribute('data-count', metric.number); number.textContent = metric.number.toLocaleString('en-IN'); } var label = item.querySelector('.impact-label'); if (label) label.textContent = metric.label; var suffix = item.querySelector('.suffix'); if (suffix) suffix.textContent = metric.suffix || ''; var bar = item.querySelector('[data-fill-bar]'); if (bar && metric.progress != null) { bar.setAttribute('data-fill-bar', metric.progress); bar.style.transform = 'scaleX(' + metric.progress + ')'; } });
    if (data.director) { text('.director-attr strong', data.director.name); text('.director-attr span', data.director.designation); text('#director .lead', data.director.text); attr('#director .about-media img', 'src', data.director.portrait); }
    renderEvents(data.events);
  }
  function hydrateTeam(items) {
    if (!items || !items.length) return;
    var cards = document.querySelectorAll('.team-featured-card');
    items.slice(0, cards.length).forEach(function (person, i) { var card = cards[i]; if (!card) return; text('h4', person.fullName, card); text('.tf-role', person.designation, card); if (person.photo) attr('img', 'src', person.photo, card); });
  }
  function hydrateEvent(event) {
    if (!event) return;
    text('#heroMotto', formatDate(event.startAt) + ' · ' + event.category); text('#heroTitle', event.title); text('#heroSub', event.summary); text('#about .lead', event.description); attr('#heroImg', 'src', event.cover && event.cover.url, document); attr('#heroImg', 'alt', event.cover && event.cover.altText || event.title, document);
    var gallery = document.querySelector('.evp-grid');
    if (gallery && event.gallery && event.gallery.length) { gallery.innerHTML = ''; event.gallery.forEach(function (item) { var figure = document.createElement('figure'); var image = document.createElement('img'); image.loading = 'lazy'; image.src = item.url; image.alt = item.altText || event.title; var caption = document.createElement('figcaption'); caption.textContent = item.caption || item.altText || ''; figure.appendChild(image); figure.appendChild(caption); gallery.appendChild(figure); }); }
    document.title = event.title + ' — NSS IIIT Naya Raipur';
  }
  function boot() {
    var legacy = mapLegacySlug();
    if (legacy) { get('/public/events/' + encodeURIComponent(legacy)).then(function (body) { hydrateEvent(body.event); }).catch(function () {}); return; }
    if (location.pathname.endsWith('/index.html') || location.pathname === '/' || location.pathname.endsWith('/team.html')) get(location.pathname.endsWith('/team.html') ? '/public/team' : '/public/home').then(function (data) { if (location.pathname.endsWith('/team.html')) hydrateTeam(data.items); else hydrateHome(data); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
