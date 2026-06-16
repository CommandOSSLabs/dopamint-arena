const DB_NAME = "BlackJackGameDB";
const STORE_NAME = "GameActions";
const VERSION = 4;

interface GameActionData {
  id?: number;
  game_id: string;
  round: number;
  step: number;
  gameActionDataHex: string;
  playerEd25519Signature: string;
  dealerBlsSignature: string;
}

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("game_id", "game_id", { unique: false });
        store.createIndex("game_round_step", ["game_id", "round", "step"]);
      }
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject("Failed to open IndexedDB");
    };
  });
};

export const addGameActionData = (
  data: GameActionData
): Promise<GameActionData> => {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("game_round_step");

      // Check for existing record with the same game_id, round, and step
      const checkRequest = index.get([data.game_id, data.round, data.step]);

      checkRequest.onsuccess = () => {
        if (checkRequest.result) {
          console.log(checkRequest.result, data);
          reject(
            "Game action data with the same game_id, round, and step already exists"
          );
        } else {
          const request = store.add(data);

          request.onsuccess = () => {
            const id = request.result as number;
            const addedData = { ...data, id }; // Include the auto-generated id
            transaction.oncomplete = () => {
              resolve(addedData);
            };
          };

          request.onerror = (e) => {
            console.log(e);
            reject("Failed to add game action data");
          };
        }
      };

      checkRequest.onerror = (e) => {
        console.log(e);
        reject("Failed to check existing game action data");
      };
    } catch (error) {
      reject(error);
    }
  });
};

export const getGameActionData = ({
  game_id,
  round,
  step,
}: {
  game_id: string;
  round: number;
  step: number;
}): Promise<GameActionData | undefined> => {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("game_round_step");
      const request = index.get([game_id, round, step]);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject("Failed to get game action data");
      };
    } catch (error) {
      reject(error);
    }
  });
};

export const updateGameActionData = (
  { game_id, round, step }: { game_id: string; round: number; step: number },
  updateData: Partial<GameActionData>
): Promise<GameActionData> => {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("game_round_step");
      const request = index.get([game_id, round, step]);

      request.onsuccess = async () => {
        const data = request.result;
        if (data) {
          Object.assign(data, updateData);
          store.put(data);
          transaction.oncomplete = () => {
            resolve(data);
          };
        } else {
          reject("Game action data not found");
        }
      };

      request.onerror = () => {
        reject("Failed to update game action data");
      };
    } catch (error) {
      reject(error);
    }
  });
};

export const getLatestGameActionData = (
  game_id: string
): Promise<GameActionData> => {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("game_id");

      const request = index.getAll(IDBKeyRange.only(game_id));

      request.onsuccess = () => {
        const results = request.result as GameActionData[];
        if (results.length > 0) {
          const maxData = results.reduce((max, data) => {
            if (
              !max ||
              data.round > max.round ||
              (data.round === max.round && data.step > max.step)
            ) {
              return data;
            }
            return max;
          }, undefined as GameActionData | undefined);

          resolve(maxData!);
        } else {
          reject("Game action data not found");
        }
      };

      request.onerror = () => {
        reject("Failed to get game action data");
      };
    } catch (error) {
      reject(error);
    }
  });
};
