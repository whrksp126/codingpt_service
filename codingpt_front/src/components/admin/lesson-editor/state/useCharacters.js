import { useEffect, useState } from 'react';
import * as api from '../../../../utils/lessonApi';

let cache = null;
let cachePromise = null;

export const useCharacters = () => {
  const [characters, setCharacters] = useState(cache || []);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (cache) return;
    if (!cachePromise) {
      cachePromise = api.listCharacters()
        .then((data) => {
          cache = data.characters || [];
          return cache;
        })
        .catch(() => {
          cache = [];
          return cache;
        });
    }
    cachePromise.then((data) => {
      setCharacters(data);
      setLoading(false);
    });
  }, []);

  return { characters, loading };
};
