// Paletas de pixel art de la comunidad, para cargar en el editor (Paleta > Paletas). Los colores vienen tal cual de
// Lospec (https://lospec.com/palette-list/<id>.json, descargados el 2026-10-25); el mérito es de sus autores.
export interface PresetPalette { id: string; name: string; author: string; colors: readonly string[] }

export const PRESET_PALETTES: readonly PresetPalette[] = [
  { id: 'pico-8', name: 'PICO-8', author: 'Lexaloffle Games', colors: [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
  ] },
  { id: 'sweetie-16', name: 'Sweetie 16', author: 'GrafxKid', colors: [
    '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
    '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
  ] },
  { id: 'endesga-32', name: 'Endesga 32', author: 'ENDESGA', colors: [
    '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
    '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
    '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
    '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
  ] },
  { id: 'apollo', name: 'Apollo', author: 'AdamCYounis', colors: [
    '#172038', '#253a5e', '#3c5e8b', '#4f8fba', '#73bed3', '#a4dddb', '#19332d', '#25562e',
    '#468232', '#75a743', '#a8ca58', '#d0da91', '#4d2b32', '#7a4841', '#ad7757', '#c09473',
    '#d7b594', '#e7d5b3', '#341c27', '#602c2c', '#884b2b', '#be772b', '#de9e41', '#e8c170',
    '#241527', '#411d31', '#752438', '#a53030', '#cf573c', '#da863e', '#1e1d39', '#402751',
    '#7a367b', '#a23e8c', '#c65197', '#df84a5', '#090a14', '#10141f', '#151d28', '#202e37',
    '#394a50', '#577277', '#819796', '#a8b5b2', '#c7cfcc', '#ebede9',
  ] },
  { id: 'endesga-64', name: 'Endesga 64', author: 'ENDESGA', colors: [
    '#ff0040', '#131313', '#1b1b1b', '#272727', '#3d3d3d', '#5d5d5d', '#858585', '#b4b4b4',
    '#ffffff', '#c7cfdd', '#92a1b9', '#657392', '#424c6e', '#2a2f4e', '#1a1932', '#0e071b',
    '#1c121c', '#391f21', '#5d2c28', '#8a4836', '#bf6f4a', '#e69c69', '#f6ca9f', '#f9e6cf',
    '#edab50', '#e07438', '#c64524', '#8e251d', '#ff5000', '#ed7614', '#ffa214', '#ffc825',
    '#ffeb57', '#d3fc7e', '#99e65f', '#5ac54f', '#33984b', '#1e6f50', '#134c4c', '#0c2e44',
    '#00396d', '#0069aa', '#0098dc', '#00cdf9', '#0cf1ff', '#94fdff', '#fdd2ed', '#f389f5',
    '#db3ffd', '#7a09fa', '#3003d9', '#0c0293', '#03193f', '#3b1443', '#622461', '#93388f',
    '#ca52c9', '#c85086', '#f68187', '#f5555d', '#ea323c', '#c42430', '#891e2b', '#571c27',
  ] },
  { id: 'aap-64', name: 'AAP-64', author: 'Adigun A. Polack', colors: [
    '#060608', '#141013', '#3b1725', '#73172d', '#b4202a', '#df3e23', '#fa6a0a', '#f9a31b',
    '#ffd541', '#fffc40', '#d6f264', '#9cdb43', '#59c135', '#14a02e', '#1a7a3e', '#24523b',
    '#122020', '#143464', '#285cc4', '#249fde', '#20d6c7', '#a6fcdb', '#ffffff', '#fef3c0',
    '#fad6b8', '#f5a097', '#e86a73', '#bc4a9b', '#793a80', '#403353', '#242234', '#221c1a',
    '#322b28', '#71413b', '#bb7547', '#dba463', '#f4d29c', '#dae0ea', '#b3b9d1', '#8b93af',
    '#6d758d', '#4a5462', '#333941', '#422433', '#5b3138', '#8e5252', '#ba756a', '#e9b5a3',
    '#e3e6ff', '#b9bffb', '#849be4', '#588dbe', '#477d85', '#23674e', '#328464', '#5daf8d',
    '#92dcba', '#cdf7e2', '#e4d2aa', '#c7b08b', '#a08662', '#796755', '#5a4e44', '#423934',
  ] },
  { id: 'resurrect-64', name: 'Resurrect 64', author: 'Kerrie Lake', colors: [
    '#2e222f', '#3e3546', '#625565', '#966c6c', '#ab947a', '#694f62', '#7f708a', '#9babb2',
    '#c7dcd0', '#ffffff', '#6e2727', '#b33831', '#ea4f36', '#f57d4a', '#ae2334', '#e83b3b',
    '#fb6b1d', '#f79617', '#f9c22b', '#7a3045', '#9e4539', '#cd683d', '#e6904e', '#fbb954',
    '#4c3e24', '#676633', '#a2a947', '#d5e04b', '#fbff86', '#165a4c', '#239063', '#1ebc73',
    '#91db69', '#cddf6c', '#313638', '#374e4a', '#547e64', '#92a984', '#b2ba90', '#0b5e65',
    '#0b8a8f', '#0eaf9b', '#30e1b9', '#8ff8e2', '#323353', '#484a77', '#4d65b4', '#4d9be6',
    '#8fd3ff', '#45293f', '#6b3e75', '#905ea9', '#a884f3', '#eaaded', '#753c54', '#a24b6f',
    '#cf657f', '#ed8099', '#831c5d', '#c32454', '#f04f78', '#f68181', '#fca790', '#fdcbb0',
  ] },
];
