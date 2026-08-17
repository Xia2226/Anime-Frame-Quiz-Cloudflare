-- 反馈记录增加处理状态：handled=已处理 / unhandled=未处理，默认未处理
ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'unhandled' CHECK (status IN ('handled', 'unhandled'));
