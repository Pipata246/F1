import React from 'react';
import { motion } from 'framer-motion';

// Модальное окно «потеря связи» с двумя действиями: retry и выход.
export const ConnectionErrorModal = ({ visible, onRetry, onExit }) => {
  if (!visible) return null;
  return (
    <motion.div
      key="connection-error"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 flex items-center justify-center z-[100] bg-black/60 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.8, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.8, y: 20 }}
        transition={{ duration: 0.3 }}
        className="px-8 py-6 rounded-2xl shadow-2xl text-center border-2 bg-gray-900/95 border-red-500"
      >
        <div className="mb-4">
          <svg className="w-16 h-16 mx-auto text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
          </svg>
        </div>
        <div className="text-2xl font-black tracking-wide uppercase text-red-400 mb-3">
          ПРОБЛЕМА С СОЕДИНЕНИЕМ
        </div>
        <div className="flex justify-center items-center gap-2 mb-4">
          <div className="w-2 h-2 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <div className="text-sm text-white/70 font-medium mb-5">
          Пытаемся восстановить связь...
        </div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onRetry}
            className="bg-white/5 border border-white/20 text-white text-sm font-bold py-2 px-4 rounded-xl active:scale-95"
          >
            Повторить
          </button>
          <button
            onClick={onExit}
            className="bg-red-600/80 border border-red-400 text-white text-sm font-bold py-2 px-4 rounded-xl active:scale-95"
          >
            Выйти
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};
