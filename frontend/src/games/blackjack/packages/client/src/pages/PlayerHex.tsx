import React, { useState, useEffect } from "react";
import { fromHEX } from "@mysten/bcs";

export default function PlayerHex() {
  const [inputValue, setInputValue] = useState("");

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
    // handleConvert();
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="bg-white p-8 rounded shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-4">HEX to Bytes Converter</h1>
        <div className="mb-4">
          <label
            htmlFor="hexInput"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Enter HEX string:
          </label>
          <input
            id="hexInput"
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md"
            placeholder="Enter HEX string"
          />
        </div>
        {inputValue && (
          <div className="mt-4 p-4 bg-gray-100 rounded-md">
            <h2 className="text-lg font-semibold">Output:</h2>
            <p className="break-words">{fromHEX(inputValue).toString()}</p>
          </div>
        )}
      </div>
    </div>
  );
}
