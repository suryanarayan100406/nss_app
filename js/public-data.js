(function () {
  'use strict';

  var api = window.NSS_API_ROOT || (location.hostname === 'localhost' && location.port !== '4000' ? 'http://localhost:4000/api/v1' : '/api/v1');
  var text = function (tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  };
  var link = function (href, label, className) {
    var node = text('a', className, label);
    node.href = href;
    return node;
  };
  var image = function (src, alt) {
    var node = document.createElement('img');
    node.src = src;
    node.alt = alt || '';
    node.loading = 'lazy';
    return node;
  };
  var error = function (root, title, message) {
    root.classList.add('public-tool-error');
    root.replaceChildren(text('h1', '', title), text('p', '', message));
  };

  function renderArchives() {
    var root = document.getElementById('years');
    if (!root) return;
    fetch(api + '/public/academic-years').then(function (response) { if (!response.ok) throw Error(); return response.json(); }).then(function (body) {
      root.replaceChildren();
      if (!body.items.length) { root.appendChild(text('p', '', 'No published academic years yet.')); return; }
      body.items.forEach(function (year) {
        var card = link('archive.html?year=' + encodeURIComponent(year.slug), '', 'archive-year');
        card.append(text('span', 'eyebrow', 'Academic year'), text('h2', '', year.label), text('span', '', year.eventCount + ' events · ' + year.rosterCount + ' roster links →'));
        root.appendChild(card);
      });
    }).catch(function () { root.replaceChildren(text('p', '', 'Archives are temporarily unavailable.')); });
  }

  function renderArchive() {
    var root = document.getElementById('archive');
    var slug = new URLSearchParams(location.search).get('year');
    if (!root) return;
    if (!slug) { error(root, 'Choose an academic year.', 'Return to the archive index to select a published year.'); return; }
    fetch(api + '/public/academic-years/' + encodeURIComponent(slug)).then(function (response) { if (!response.ok) throw Error(); return response.json(); }).then(function (body) {
      var year = body.year;
      document.title = year.label + ' Archive — NSS IIIT Naya Raipur';
      document.querySelector('#archive h1').textContent = year.label;
      document.getElementById('intro').textContent = 'Published events and community galleries from this academic year.';
      var events = document.getElementById('events');
      events.replaceChildren();
      if (!year.events.length) { events.appendChild(text('p', '', 'No published events in this archive.')); return; }
      year.events.forEach(function (event) {
        var card = text('article', 'archive-event', '');
        if (event.cover && event.cover.url) card.appendChild(image(event.cover.url, event.cover.altText || event.title));
        card.append(text('span', 'eyebrow', event.category + ' · ' + new Date(event.startAt).toLocaleDateString('en-IN')), text('h2', '', event.title), text('p', '', event.summary), link('event.html?slug=' + encodeURIComponent(event.slug), 'View event →', 'text-link'));
        events.appendChild(card);
      });
    }).catch(function () { error(root, 'Archive unavailable.', 'This academic year may be private or unpublished.'); });
  }

  function renderCalendar() {
    var items = document.getElementById('items');
    var label = document.getElementById('month');
    if (!items || !label) return;
    var month = new Date();
    function load() {
      var from = new Date(month.getFullYear(), month.getMonth(), 1).toISOString();
      var to = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59).toISOString();
      label.textContent = month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      fetch(api + '/public/events?pageSize=100&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)).then(function (response) { if (!response.ok) throw Error(); return response.json(); }).then(function (body) {
        items.replaceChildren();
        if (!body.items.length) { items.appendChild(text('div', 'public-event', 'No published events in this month.')); return; }
        body.items.forEach(function (event) {
          var date = new Date(event.startAt);
          var card = text('article', 'public-event', '');
          var dateBlock = text('div', 'public-event-date', '');
          dateBlock.append(text('strong', '', date.toLocaleDateString('en-IN', { day: '2-digit' })), text('span', '', date.toLocaleDateString('en-IN', { weekday: 'short' })));
          var copy = text('div', '', '');
          copy.append(text('span', 'eyebrow', event.category), text('h2', '', event.title), text('p', '', date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: event.timezone }) + ' · ' + (event.venue || 'Venue to be announced') + ' · ' + event.timezone));
          card.append(dateBlock, copy, link('event.html?slug=' + encodeURIComponent(event.slug), 'View story →', ''));
          items.appendChild(card);
        });
      }).catch(function () { items.replaceChildren(text('div', 'public-event', 'Calendar is temporarily unavailable.')); });
    }
    document.getElementById('prev').onclick = function () { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); load(); };
    document.getElementById('next').onclick = function () { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); load(); };
    document.getElementById('today').onclick = function () { month = new Date(); load(); };
    load();
  }

  function renderEvent() {
    var root = document.getElementById('eventPage');
    var slug = new URLSearchParams(location.search).get('slug');
    if (!root) return;
    if (!slug) { error(root, 'Event not found', 'Choose an event from the public calendar.'); return; }
    fetch(api + '/public/events/' + encodeURIComponent(slug)).then(function (response) { if (!response.ok) throw Error(); return response.json(); }).then(function (body) {
      var event = body.event;
      var date = new Date(event.startAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
      document.title = event.title + ' — NSS IIIT Naya Raipur';
      root.replaceChildren();
      var hero = text('section', 'dynamic-hero', '');
      var media = text('div', 'dynamic-hero-media', '');
      if (event.cover && event.cover.url) media.appendChild(image(event.cover.url, event.cover.altText || event.title));
      var copy = text('div', 'dynamic-copy', '');
      copy.append(text('span', 'eyebrow', event.category + ' · ' + date), text('h1', '', event.title), text('p', 'lead', event.summary));
      var meta = text('div', 'dynamic-meta', '');
      meta.append(text('span', '', date), text('span', '', event.timezone), text('span', '', event.venue || 'Venue to be announced'));
      copy.append(meta, link('/api/v1/public/events/' + encodeURIComponent(event.slug) + '.ics', 'Download calendar', 'btn-primary'));
      hero.append(media, copy);
      var main = text('main', 'dynamic-main', '');
      main.append(text('span', 'eyebrow', 'Event story'), text('h2', '', 'Service, remembered in photographs.'), text('p', 'dynamic-story', event.description || event.summary));
      var gallery = text('section', 'dynamic-gallery', '');
      var galleryTitle = text('h2', '', 'Published gallery');
      galleryTitle.style.gridColumn = '1 / -1';
      gallery.appendChild(galleryTitle);
      if (event.gallery && event.gallery.length) event.gallery.forEach(function (item) { var figure = text('figure', '', ''); figure.append(image(item.url, item.altText || 'Event photograph'), text('figcaption', '', (item.caption || item.altText || '') + (item.credit ? ' · ' + item.credit : ''))); gallery.appendChild(figure); });
      else gallery.appendChild(text('p', '', 'No published community photographs yet.'));
      main.appendChild(gallery);
      root.append(hero, main);
    }).catch(function () { error(root, 'Event unavailable', 'This event may be a draft, scheduled, or no longer published.'); });
  }

  renderArchives();
  renderArchive();
  renderCalendar();
  renderEvent();
}());
