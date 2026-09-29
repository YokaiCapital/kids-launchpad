CREATE TABLE IF NOT EXISTS public_market_swaps(
 genesis TEXT NOT NULL,pool TEXT NOT NULL,signature TEXT NOT NULL,path TEXT NOT NULL,
 order_key TEXT NOT NULL,block_time BIGINT NOT NULL,record TEXT NOT NULL,fingerprint TEXT NOT NULL,
 PRIMARY KEY(genesis,pool,signature,path)
);
CREATE TABLE IF NOT EXISTS public_market_candles(
 genesis TEXT NOT NULL,pool TEXT NOT NULL,interval TEXT NOT NULL,bucket BIGINT NOT NULL,
 open TEXT NOT NULL,high TEXT NOT NULL,low TEXT NOT NULL,close TEXT NOT NULL,
 volume_sol TEXT NOT NULL,volume_coin TEXT NOT NULL,trades BIGINT NOT NULL,buys BIGINT NOT NULL,sells BIGINT NOT NULL,
 open_key TEXT NOT NULL,close_key TEXT NOT NULL,first_slot BIGINT NOT NULL,last_slot BIGINT NOT NULL,
 PRIMARY KEY(genesis,pool,interval,bucket)
);
CREATE TABLE IF NOT EXISTS public_market_cursors(
 genesis TEXT NOT NULL,pool TEXT NOT NULL,stream TEXT NOT NULL,revision BIGINT NOT NULL,
 body TEXT NOT NULL,updated_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,pool,stream)
);
