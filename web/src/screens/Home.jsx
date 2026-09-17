import React from 'react';
import Board from '../Board.jsx';
import html from './home.html?raw';

/* Straight from the design board. The only live parts are the two calls to action
   and the theme switch. */
export default function Home({ go, dark, setDark }) {
  return (
    <Board
      html={html}
      vals={{ dark, light: !dark }}
      on={{
        go_signup: () => go('signup'),
        go_signin: () => go('signin'),
        toggleTheme: () => setDark(!dark),
      }}
    />
  );
}
