import React from 'react';
import html from '../home.html?raw';

/* The homepage is lifted straight from the design board by scripts/lift-design.js, so it
   cannot drift from what was signed off. The only live parts are the links, which carry a
   data-go attribute the click below delegates on. */
export default function Home({ go, toggleTheme }) {
  const onClick = (e) => {
    const hit = e.target.closest('[data-go]');
    if (!hit) return;
    e.preventDefault();
    const where = hit.getAttribute('data-go');
    if (where === 'theme') toggleTheme();
    else go(where);
  };
  return <div className="homewrap" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
